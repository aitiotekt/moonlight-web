"""mwsr 2 and 3's deblocking (frontend DeblockShader.js) on the software adapter.

    python -X utf8 deblock_check.py [--dir DIR] [--frame N] [--clip PATH]

One frame of a low-rate H.264 encode of the CoD clip (P8.0's offline encodes,
bench-out/scaler-lab/p8/off) is decoded to a PNG; deblock-check.html then runs
the product's two passes alone on it, and the product's WebGpuRenderer with
algo 'mwsr' and deblock null, 'fixed' and 'qp' (deblock-check.js). Here:
  - the passes against numpy (p8/p8_filters.py's dct_shrink, the same luma,
    the same bound): within one code value, a hundredth of one on average;
  - the renderer: no WebGPU error, the frame it deblocked the same as the
    passes alone, its picture moved from plain mwsr's, and mwsr 3's frame of
    QP 18 (no pass) the same as plain mwsr's.
Chrome runs headless on SwiftShader only (--use-webgpu-adapter=swiftshader;
the page refuses any other adapter before asking for a device), at
BelowNormal on CPUs 16-23, with a profile of its own and --mute-audio; its
tree is killed at the end ("chrome left: 0"). Exit 1 on a failed check.
"""
import argparse
import base64
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import numpy as np
import psutil
import websocket

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "p8"))
from scaler_lab import CHROME, REPO, LabHandler, free_port  # noqa: E402
from p8_filters import dct_shrink  # noqa: E402

BELOW_NORMAL = 0x00004000
CREATE_SUSPENDED = 0x00000004
CPUS = list(range(16, 24))
L709 = np.array([0.2126, 0.7152, 0.0722])


def decode_frame(clip, n, out):
    """Frame n of the clip as the client's picture: limited-range BT.709 to RGB."""
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-threads", "8", "-i", clip,
                    "-vf", "select=eq(n\\,%d),scale=in_color_matrix=bt709:in_range=tv:out_range=pc,"
                    "format=rgb24" % n, "-frames:v", "1", out],
                   check=True, creationflags=BELOW_NORMAL)


def reference(rgb, s):
    """numpy's deblocked frame: the luma's shrinkage, its change bounded, on RGB."""
    x = rgb.astype(np.float64) / 255.0
    y = x @ L709
    thr = s["thr"] * 255 / 219
    cmax = s["cmax"] * 255 / 219
    yd = dct_shrink((y * 255.0).astype(np.float32), [thr])[thr] / 255.0
    dy = np.clip(yd - y, -cmax / 255.0, cmax / 255.0)
    return np.clip(np.round(np.clip(x + dy[..., None], 0, 1) * 255.0), 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(REPO, "bench-out", "scaler-lab", "deblock"))
    ap.add_argument("--clip", default=os.path.join(REPO, "bench-out", "scaler-lab", "p8", "off",
                                                   "enc-cod-cloud-720-avc-4000.mkv"))
    ap.add_argument("--frame", type=int, default=75)
    ap.add_argument("--timeout", type=float, default=600)
    a = ap.parse_args()
    os.makedirs(a.dir, exist_ok=True)
    png = os.path.join(a.dir, "frame-%d.png" % a.frame)
    if not os.path.exists(png):
        decode_frame(a.clip, a.frame, png)
    import imageio.v3 as iio
    rgb = iio.imread(png)[..., :3]

    port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(LabHandler, directory=REPO))
    server.lab_dir = a.dir
    threading.Thread(target=server.serve_forever, daemon=True).start()

    cdp = free_port()
    profile = tempfile.mkdtemp(prefix="mw-scaler-lab-")
    flags = ["--headless=new", "--remote-debugging-port=%d" % cdp, "--user-data-dir=" + profile,
             "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-webgpu-adapter=swiftshader",
             "--mute-audio", "--no-first-run", "--no-default-browser-check",
             "--disable-background-timer-throttling", "--disable-renderer-backgrounding"]
    # Suspended until its priority and CPUs are set: the processes it starts take both.
    chrome = subprocess.Popen([CHROME, *flags, "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              creationflags=BELOW_NORMAL | CREATE_SUSPENDED)
    proc = psutil.Process(chrome.pid)
    proc.cpu_affinity(CPUS)
    proc.resume()
    res = None
    try:
        page = None
        for _ in range(100):
            try:
                targets = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % cdp))
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        if not page:
            raise SystemExit("no page on the DevTools port %d" % cdp)
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=600, suppress_origin=True)
        ids = iter(range(1, 1 << 30))

        def call(method, **params):
            mid = next(ids)
            ws.send(json.dumps({"id": mid, "method": method, "params": params}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid:
                    return msg.get("result", msg)

        rel = os.path.relpath(png, REPO).replace(os.sep, "/")
        call("Page.navigate", url="http://127.0.0.1:%d/scripts/bench/scaler-lab/deblock-check.html?img=/%s"
             % (port, rel))
        deadline = time.time() + a.timeout
        while time.time() < deadline:
            time.sleep(1)
            r = call("Runtime.evaluate", returnByValue=True, expression="window.__done || null")
            res = r.get("result", {}).get("value")
            if res:
                break
        ws.close()
    finally:
        tree = [chrome.pid]
        try:
            tree += [c.pid for c in proc.children(recursive=True)]
        except psutil.Error:
            pass
        for pid in tree:
            try:
                psutil.Process(pid).kill()
            except psutil.Error:
                pass
        time.sleep(1)
        left = [p.pid for p in psutil.process_iter(["cmdline"])
                if p.info["cmdline"] and any(profile in c for c in p.info["cmdline"])]
        print("chrome left: %d" % len(left))
        shutil.rmtree(profile, ignore_errors=True)
        server.shutdown()

    if not res:
        raise SystemExit("the page gave no answer in %d s" % a.timeout)
    if not res.get("ok"):
        raise SystemExit("the page failed: %s" % res.get("error"))

    fails = []
    print("adapter: %s, frame %dx%d" % (res["adapter"], *res["size"]))
    if res["errors"]:
        fails.append("WebGPU errors (passes alone): %s" % res["errors"][:3])
    summary = {"adapter": res["adapter"], "frame": png, "alone": {}, "renderer": {}}
    for k, al in res["alone"].items():
        gpu = np.frombuffer(base64.b64decode(al["rgba"]), np.uint8).reshape(rgb.shape[0], rgb.shape[1], 4)[..., :3]
        ref = reference(rgb, al["strength"])
        d = np.abs(gpu.astype(int) - ref.astype(int))
        moved = np.abs(ref.astype(int) - rgb.astype(int))
        row = {"strength": al["strength"], "ms": round(al["ms"]), "max_vs_numpy": int(d.max()),
               "mean_vs_numpy": float(d.mean()), "moved_mean": float(moved.mean()),
               "moved_max": int(moved.max()), "vs_input": al["vsInput"]}
        summary["alone"][k] = row
        print("alone %-5s t%.2f c%.2f: vs numpy max %d mean %.4f; moved mean %.3f max %d; %d ms"
              % (k, al["strength"]["thr"], al["strength"]["cmax"], row["max_vs_numpy"], row["mean_vs_numpy"],
                 row["moved_mean"], row["moved_max"], row["ms"]))
        if row["max_vs_numpy"] > 1 or row["mean_vs_numpy"] > 0.01:
            fails.append("alone %s differs from numpy (max %d, mean %.4f)" % (k, row["max_vs_numpy"],
                                                                              row["mean_vs_numpy"]))
        if row["moved_mean"] <= 0:
            fails.append("alone %s moved nothing" % k)
    for mode, out in res["renderer"].items():
        summary["renderer"][mode] = out
        if out["errors"] or out["failed"]:
            fails.append("renderer %s: errors %s, failed %s" % (mode, out["errors"][:3], out["failed"]))
        if out["wantsFrameQp"] != (mode == "qp"):
            fails.append("renderer %s: wantsFrameQp %s" % (mode, out["wantsFrameQp"]))
        for d in out["draws"]:
            line = "renderer %-5s ts %d qp %s: %s" % (mode, d["ts"], d["qp"], d["deblockLast"])
            vp = d.get("vsPlain")
            if vp:
                # Identical pictures: an infinite PSNR, which JSON hands back as null.
                vp["psnr"] = float("inf") if vp["psnr"] is None else vp["psnr"]
                line += "; vs plain mwsr max %d psnr %.1f" % (vp["max"], vp["psnr"])
            db = d.get("dbTexVsAlone")
            if db:
                line += "; dbTex vs alone max %d" % db["max"]
                if db["max"] > 1:
                    fails.append("renderer %s ts %d: dbTex differs from the passes alone" % (mode, d["ts"]))
            print(line)
            if mode == "plain":
                continue
            skipped = mode == "qp" and d["qp"] == 18
            if skipped and (d["deblockLast"]["thr"] != 0 or vp["max"] != 0):
                fails.append("renderer qp: the QP 18 frame was not left alone")
            if not skipped and (vp["max"] == 0 or vp["psnr"] < 30 or not db):
                fails.append("renderer %s ts %d: the picture did not move as it should" % (mode, d["ts"]))
    with open(os.path.join(a.dir, "deblock-check.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print("FAIL:\n  " + "\n  ".join(fails) if fails else "all checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
