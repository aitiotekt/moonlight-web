"""P8.0, step 1, offline and CPU only: how much blocking a realtime encoder
leaves in a fast scene, and how much of it a client-side filter takes away.

  python p8_offline.py prep [content…]     sources, yuv420p, every content × size
  python p8_offline.py encode [content…]   x264 / x265 / libaom, realtime, one-frame VBV

Then, each writing its results next to the encodes (bench-out/scaler-lab/p8/off):
  p8_q1.py                  how much blocking each encode leaves, no filter yet
  p8_sweep.py, p8_table.py  every candidate filter at several strengths, and ffmpeg's own
  p8_sweep2.py, p8_policy.py  the DCT filter around its optimum, per frame, and the
                            strength policies (fixed, from the frame's QP, blind, oracle)
  p8_crops.py               colour crops of a frame, the filters applied
  p8_check_filters.py, p8_check_wgsl.py  the filters' self-checks, and the WGSL passes of
                            seq-lab.js transliterated thread by thread against them
The lab's campaign is scaler_lab.py --p7 (p7_flows.py, --p7-video for the clips);
p8_gate.py applies its gate, p8_labcrops.py makes PNGs of its crops.

This process and its children run BelowNormal; ffmpeg gets 8 threads at most.
"""
import ctypes, json, os, subprocess, sys, time

ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
OUT = os.path.join(REPO, "bench-out", "scaler-lab", "p8", "off").replace(os.sep, "/")
COD = os.path.join(os.path.expanduser("~"), ".mw-bench", "content", "cod.webm").replace(os.sep, "/")
# the lab's text picture, as P7.0's campaign copied it into its directory
TEXT = os.path.join(REPO, "bench-out", "scaler-lab", "p7", "p7c-src-text.png").replace(os.sep, "/")
GAME = "C:/Test/01_4K.png"
N, WARM, STEP = 180, 60, 3  # frames per source; the first WARM not measured; every STEP-th measured
SIZES = {"720": (1280, 720), "1080": (1920, 1080)}
# The clip's busiest windows (packet sizes): 38 s an explosion against a wall,
# 121.5 s a flight through clouds; 33 s a calm one. The stills pan 3 px of the
# 3840×2160 picture a frame (1.25 px at 720p, 1.9 px at 1080p).
CONTENTS = {
    "cod-boom": ("cod", 38.0),
    "cod-cloud": ("cod", 121.5),
    "cod-calm": ("cod", 33.0),
    "text-pan": ("still", TEXT),
    "game-pan": ("still", GAME),
}
KBPS = {
    "720": {"avc": [4000, 8000, 16000], "hevc": [4000, 8000], "av1": [4000, 8000]},
    "1080": {"avc": [6000, 12000, 24000], "hevc": [6000, 12000], "av1": [6000, 12000]},
}


def run(cmd):
    t = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.stderr.write(r.stderr[-3000:])
        raise SystemExit("failed: " + " ".join(cmd[:12]))
    return time.time() - t


def src_path(content, size):
    return "%s/src-%s-%s.yuv" % (OUT, content, size)


def prep(content, size):
    kind, arg = CONTENTS[content]
    w, h = SIZES[size]
    out = src_path(content, size)
    if kind == "cod":
        cmd = ["ffmpeg", "-v", "error", "-y", "-threads", "8", "-ss", "%.3f" % (arg - WARM / 60.0), "-i", COD,
               "-frames:v", str(N), "-an", "-vf", "scale=%d:%d:flags=lanczos+accurate_rnd+full_chroma_int" % (w, h),
               "-pix_fmt", "yuv420p", "-f", "rawvideo", out]
    else:
        vf = ("crop=3072:1728:x='192+3*n':y=216,"
              "scale=%d:%d:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,"
              "format=yuv420p" % (w, h))
        cmd = ["ffmpeg", "-v", "error", "-y", "-threads", "8", "-loop", "1", "-framerate", "60", "-i", arg,
               "-frames:v", str(N), "-vf", vf, "-f", "rawvideo", out]
    dt = run(cmd)
    n = os.path.getsize(out) // (w * h * 3 // 2)
    print("prep %-10s %-4s %d frames  %.1f s" % (content, size, n, dt), flush=True)
    if n != N:
        raise SystemExit("short source")


def enc_path(content, size, codec, kbps):
    return "%s/enc-%s-%s-%s-%d.mkv" % (OUT, content, size, codec, kbps)


def encode(content, size, codec, kbps):
    w, h = SIZES[size]
    out = enc_path(content, size, codec, kbps)
    buf = str(kbps * 1000 // 60)  # one frame, as the native host (RateControl.h)
    rate = ["-b:v", "%dk" % kbps, "-maxrate", "%dk" % kbps, "-bufsize", buf]
    if codec == "avc":
        c = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high", "-bf", "0",
             "-g", "9999", "-keyint_min", "9999", "-sc_threshold", "0", "-threads", "8",
             "-x264-params", "sliced-threads=0:slices=1"] + rate  # one slice, as NVENC: no seams
    elif codec == "hevc":
        c = ["-c:v", "libx265", "-preset", "veryfast", "-tune", "zerolatency"] + rate + [
             "-x265-params", "bframes=0:keyint=9999:min-keyint=9999:scenecut=0:pools=8:frame-threads=1:log-level=error"]
    else:
        c = ["-c:v", "libaom-av1", "-usage", "realtime", "-cpu-used", "8", "-row-mt", "1", "-threads", "8",
             "-g", "9999", "-lag-in-frames", "0", "-minrate", "%dk" % kbps] + rate
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "%dx%d" % (w, h),
           "-r", "60", "-i", src_path(content, size), "-an"] + c + ["-vstats_file", out[:-4] + ".vst", out]
    dt = run(cmd)
    # the measured frames' rate, from the packets
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=size",
                        "-of", "csv=p=0", out], capture_output=True, text=True)
    sizes = [int(x) for x in r.stdout.split() if x.strip().isdigit()]
    meas = sizes[WARM:]
    mbps = sum(meas) * 8 * 60 / max(1, len(meas)) / 1e6
    print("enc  %-10s %-4s %-4s %5d  %3d pkts  %.2f Mbit/s measured  %.1f s" %
          (content, size, codec, kbps, len(sizes), mbps, dt), flush=True)
    return {"content": content, "size": size, "codec": codec, "kbps": kbps, "packets": len(sizes),
            "mbps": round(mbps, 3), "first_kbit": round(sizes[0] * 8 / 1000, 1) if sizes else 0}


def main():
    os.makedirs(OUT, exist_ok=True)
    what = sys.argv[1]
    contents = sys.argv[2:] or list(CONTENTS)
    if what == "prep":
        for c in contents:
            for s in SIZES:
                prep(c, s)
    elif what == "encode":
        log = []
        for c in contents:
            for s in SIZES:
                for codec, rates in KBPS[s].items():
                    for k in rates:
                        log.append(encode(c, s, codec, k))
        p = "%s/encodes.json" % OUT
        old = json.load(open(p)) if os.path.exists(p) else []
        keep = [e for e in old if (e["content"], e["size"], e["codec"], e["kbps"]) not in
                {(e2["content"], e2["size"], e2["codec"], e2["kbps"]) for e2 in log}]
        json.dump(keep + log, open(p, "w"), indent=1)


if __name__ == "__main__":
    main()
