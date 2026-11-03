"""Run the reference PyroWave (mw-pyrowave-ref) over the lab corpus: encode,
decode, PSNR, and the GPU time of each pass, per clip, rate and GPU.

    python oracle.py [--corpus DIR] [--mbps 170,250] [--vendor 0x10de,0x1002] [--clips text,game]

Streams (.pwv) and decoded frames stay in the corpus folder, named
<clip>-<mbps>-<vendor>, for the ports to be checked against. A summary is
printed and written to <corpus>/oracle.json.
"""
import argparse
import glob
import json
import os
import re
import subprocess

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TOOL = os.path.join(REPO, "build-pyrowave-ref", "mw-pyrowave-ref.exe")
CORPUS = os.path.join(os.path.expanduser("~"), ".mw-bench", "ultra-corpus")


def run(args):
    out = subprocess.run([TOOL] + args, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError("%s: %s" % (" ".join(args), out.stderr.strip()))
    return [json.loads(line) for line in out.stdout.splitlines() if line.startswith("{")]


def gpu_times(lines):
    """{"DWT": 0.249, ...} from the library's 'X: 0.249 ms per frame' lines."""
    times = {}
    for line in lines:
        m = re.match(r"\s*(.+?): ([\d.]+) ms per frame", line.get("gpu", ""))
        if m:
            times[m.group(1)] = float(m.group(2))
    return times


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=CORPUS)
    ap.add_argument("--mbps", default="170")
    ap.add_argument("--vendor", default="0x10de")
    ap.add_argument("--clips", default="")
    a = ap.parse_args()
    clips = sorted(glob.glob(os.path.join(a.corpus, "*-[0-9]*p.y4m")))
    if a.clips:
        clips = [c for c in clips if os.path.basename(c).split("-")[0] in a.clips.split(",")]
    results = []
    for clip in clips:
        name = os.path.basename(clip)[:-4]
        for mbps in a.mbps.split(","):
            for vendor in a.vendor.split(","):
                base = os.path.join(a.corpus, "%s-%s-%s" % (name, mbps, vendor))
                enc = run(["encode", clip, base + ".pwv", "--mbps", mbps, "--vendor", vendor])
                dec = run(["decode", base + ".pwv", base + "-dec.y4m", "--vendor", vendor])
                score = run(["psnr", clip, base + "-dec.y4m"])[-1]
                frames = [l for l in enc if "bytes" in l]
                et, dt = gpu_times(enc), gpu_times(dec)
                r = {
                    "clip": name, "mbps": float(mbps), "gpu": enc[0].get("gpu_name"),
                    "mean_mbps": enc[-1]["mean_mbps"],
                    "max_kib": max(f["bytes"] for f in frames) / 1024,
                    "packets": max(f["packets"] for f in frames),
                    "psnr_y": score["psnr_y"], "psnr_u": score["psnr_u"], "psnr_v": score["psnr_v"],
                    "min_psnr_y": score["min_psnr_y"],
                    "encode_gpu_ms": round(sum(et.values()), 3), "decode_gpu_ms": round(sum(dt.values()), 3),
                    "encode_passes": et, "decode_passes": dt,
                }
                results.append(r)
                print("%-14s %5s Mbit/s %-28s got %6.1f Mbit/s, PSNR Y/U/V %5.2f/%5.2f/%5.2f (min Y %5.2f), "
                      "GPU encode %.3f ms, decode %.3f ms"
                      % (name, mbps, r["gpu"], r["mean_mbps"], r["psnr_y"], r["psnr_u"], r["psnr_v"],
                         r["min_psnr_y"], r["encode_gpu_ms"], r["decode_gpu_ms"]))
    with open(os.path.join(a.corpus, "oracle.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
