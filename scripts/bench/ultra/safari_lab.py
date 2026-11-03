"""Run decoder-lab.html in a browser nothing can drive (Safari on a Mac): the
page is opened by a command, and POSTs its result back here (&post=).

    python safari_lab.py --http-port 8765 --opener "ssh mw-mac open -a Safari {qurl}"
                         [--clips text10-1080p,game10-1080p] [--api webgpu,webgl2]

The opener's {url} is replaced by the page's URL, {qurl} by the same quoted
for a remote shell (ssh); with neither, the URL is appended.

Serves the repository and the corpus on 127.0.0.1:<port> as decoder_lab.py
does; the browser's machine reaches it through `ssh -R <port>:127.0.0.1:<port>`,
so the page is on its loopback (a secure context, which WebGPU needs). Prints
the same lines as decoder_lab.py and writes <corpus>/safari-lab.json.
"""
import argparse
import functools
import http.server
import json
import os
import queue
import shlex
import subprocess
import threading

import decoder_lab as dl

results = queue.Queue()


class Handler(dl.Handler):
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/lab-result":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(204)
        self.end_headers()
        try:
            results.put(json.loads(body))
        except ValueError:
            results.put({"result": {"error": "unreadable result"}})


def line(clip, mbps, api, res):
    if "error" in res:
        return "%-15s %4s Mbit/s %-6s ERROR %s" % (clip, mbps, api, res["error"][:300])
    g = res.get("gpuMs") or {}
    w = res.get("wallMs") or {}
    return ("%-15s %4s Mbit/s %-6s %s  max diff Y %d C %d vs oracle (min PSNR %.1f dB), PSNR-Y vs source "
            "%.2f dB, ready %s, GPU decode p50 %s ms p99 %s ms, wall p50 %s ms p99 %s ms%s"
            % (clip, mbps, api, res["adapter"], res["maxDiff"], res["maxDiffC"], res["minPsnrVsOracle"],
               res["meanPsnrVsSource"], res["allReady"],
               "%.3f" % g["p50"] if g else "-", "%.3f" % g["p99"] if g else "-",
               "%.2f" % w["p50"] if w else "-", "%.2f" % w["p99"] if w else "-",
               " ERRORS %s" % res["errors"] if res.get("errors") else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default="text10-1080p,game10-1080p,noise10-1080p")
    ap.add_argument("--mbps", default="170")
    ap.add_argument("--ref", default="0x10de")
    ap.add_argument("--frames", type=int, default=10)
    ap.add_argument("--timing", type=int, default=100)
    ap.add_argument("--api", default="webgpu,webgl2")
    ap.add_argument("--http-port", type=int, required=True)
    ap.add_argument("--opener", required=True,
                    help="command that opens the page: {url}, {qurl} (quoted for ssh) or appended")
    ap.add_argument("--timeout", type=int, default=300, help="seconds to wait for each result")
    a = ap.parse_args()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", a.http_port), functools.partial(Handler, directory=dl.REPO))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    out = []
    try:
        for api in a.api.split(","):
            for clip in a.clips.split(","):
                base = "http://127.0.0.1:%d" % a.http_port
                url = ("%s/scripts/bench/ultra/decoder-lab.html?clip=%s&mbps=%s&ref=%s&frames=%d&timing=%d"
                       "&api=%s&post=%s/lab-result" % (base, clip, a.mbps, a.ref, a.frames, a.timing, api, base))
                args = [url if t == "{url}" else shlex.quote(url) if t == "{qurl}" else t
                        for t in shlex.split(a.opener)]
                subprocess.run(args if args != shlex.split(a.opener) else args + [url], check=False)
                try:
                    got = results.get(timeout=a.timeout)
                except queue.Empty:
                    got = {"result": {"error": "no result in %d s" % a.timeout}}
                res = got.get("result") or {"error": "empty result"}
                out.append({"clip": clip, "api": api, "ua": got.get("ua"), "result": res})
                print(line(clip, a.mbps, api, res), flush=True)
    finally:
        server.shutdown()
    with open(os.path.join(dl.CORPUS, "safari-lab.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
