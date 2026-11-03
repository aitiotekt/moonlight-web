"""The P7.0 flow of the laboratory driver (plan upscaler-mwsr.md §14.3): does a
memory of the previous frames make mwsr better, or steadier, without a trail?
The sequences of seq-lab.js — a sub-pixel pan, a stop, a cut; a fast pan; a
block crossing a still picture — on two pictures, at ×2 and ×1.33 to 1440p,
through WebCodecs at two bitrates, mwsr alone against mwsr with a history.
The page measures every frame (the PSNR, the instability of the error, the
flicker where the truth holds still, the error in the block's wake); FLIP is
taken here on a few frames' crops. Then the table per sequence and the gate of
§14.3, with the thresholds of the plan (Bruno's to fix). Called from
scaler_lab.py (--p7, --p7-table) with its `run_page`.

    python scaler_lab.py --tag p7ss --swiftshader --p7 --p7-text <3840x2160 text.png>
                         [--p7-case x2,x133] [--p7-content text,game] [--p7-seq slow,mid,…]
                         [--p7-hist none,pull:a=0.5;t=6,…] [--p7-kbps 20000,10000]
                         [--p7-roi full] [--p7-warm 60] --page-timeout 7200
    python scaler_lab.py --tag p7ss --p7-table p7ss      (the tables again, no Chrome)

P8.0 (§14.6) measures a deblocking pass before the kernel the same way (the
variants dbe and dbd of seq-lab.js), on the pictures or on windows of the CoD
capture played as clips, the truth being the clip's frame:

    python scaler_lab.py --tag p8v --swiftshader --p7 --p7-case x2 --p7-seq vid
                         --p7-video cloud=121.5,boom=38 --p7-content cloud,boom
                         --p7-hist "none,dbd:t=3;n=16,dbd:t=12;n=16;c=4" --p7-kbps 10000,4000
"""
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import metrics  # noqa: E402

try:  # the logs go to files on Windows: never let a cp1252 console choke on a sign
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

# The sequences: the segments, the pan's speed in stream pixels a frame, the
# block's (obj). The slow ones are the gate's (§14.3: 0.3 to 2 px a frame);
# `rapid` and `obj` look for the trail.
SEQS = {
    "slow": ("pan:60,stop:20,cutpan:20", 0.3, 0.0),
    "mid": ("pan:60,stop:20,cutpan:20", 1.0, 0.0),
    "fast": ("pan:60,stop:20,cutpan:20", 2.0, 0.0),
    "rapid": ("pan:30,stop:10,cut:10", 6.0, 0.0),
    "obj": ("obj:40", 0.0, 8.0),
    # the trial pass (59's rule: its time per page before the campaign), every
    # path of the page in a few frames, one crop at the cut
    "try": ("pan:3,stop:1,cutpan:2", 1.0, 0.0),
    "tryobj": ("obj:6", 0.0, 8.0),
    # P8.0: a clip of the CoD capture (--p7-video), the window still on the
    # whole frame: 60 frames after the warm-up's, and the trial's few
    "vid": ("pan:60", 0.0, 0.0),
    "tryvid": ("pan:6", 0.0, 0.0),
}
VIDEO_SEQS = ("vid", "tryvid")
DEFAULT_SEQS = "slow,mid,fast,rapid,obj"
SLOW = ("slow", "mid")
FAST = ("rapid", "obj")
# The frames of each segment whose crops get a FLIP (offsets into the segment).
DUMP_AT = {"pan": (10, 30, 50), "stop": (5, 15), "cut": (0, 2, 9), "cutpan": (0, 2, 10), "obj": (10, 20, 30)}

CASES = {"x2": ("1280x720", "2560x1440"), "x133": ("1920x1080", "2560x1440")}
# One window for every sequence, the same ground truth at 1440p: 3360 source
# pixels of a 3840×2160 picture leave room for the longest pan (rapid: 180
# stream pixels at ×2, 458 source pixels).
BOX = (0, 40, 3360)
CROP = (960, 540, 640, 360)
CROP_OBJ = (192, 432, 1024, 576)  # the block's track, its wake inside
# The region shaded and measured at 1440p (seq-lab.js, roi): a quarter of the
# screen, its centre for the pans (the crops inside), for obj the block's
# whole track and wake (x 128 to 1180 at ×2, y 576 to 864). --p7-roi full
# shades the whole screen, four times the work: the check of the region.
ROI = (640, 360, 1280, 720)
ROI_OBJ = (64, 360, 1280, 720)
# The encoder's warm-up: a second of the first frame, still, encoded before
# every sequence and not measured (the rate control settles on it).
WARM = 60
HIST = "none,pull:a=0.5;t=6,pull:a=0.75;t=10,soft:a=0.75;t=16,clamp:a=0.75,mcpull:a=0.75;t=10,mcclamp:a=0.75,outmc:a=0.75"
KBPS = "20000,10000"
# P8.0's clips: the capture of the offline step (2560x1440, 60 fps), each
# window from its start minus the warm-up, as PNG frames in the run's
# directory (made once, shared by the tags), the warm-up's then the
# sequence's; the page's window is the whole frame.
COD = os.path.join(os.path.expanduser("~"), ".mw-bench", "content", "cod.webm")
VID_FRAMES = WARM + 60
VID_BOX = (0, 0, 2560)

# The gate of §14.3, the plan's figures until Bruno sets his: on the slow pans,
# +0.3 dB or 0.005 of FLIP, and the flicker halved; no trail measurable beyond
# mwsr alone on the fast ones (0.1 dB here).
GATE = {"psnr": 0.3, "flip": -0.005, "flicker": 0.5, "trail": -0.1}


def segments(segs):
    out = []
    for part in segs.split(","):
        kind, n = part.split(":")
        out.append((kind, int(n)))
    return out


def dump_frames(segs):
    t0 = 0
    frames = []
    for kind, n in segments(segs):
        frames += [t0 + k for k in DUMP_AT.get(kind, ()) if k < n]
        t0 += n
    return frames


def clip_frames(a, name, start):
    """The frames of a window of the capture, <dir>/vid-<name>-000.png and
    on (ffmpeg BelowNormal, 8 threads), made if missing; → their prefix for
    the page."""
    prefix = "vid-%s-" % name
    if not os.path.exists(os.path.join(a.dir, "%s%03d.png" % (prefix, VID_FRAMES - 1))):
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-threads", "8", "-ss", "%.3f" % (start - WARM / 60.0), "-i", COD,
            "-frames:v", str(VID_FRAMES), "-an",
            "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24",
            "-start_number", "0", os.path.join(a.dir, prefix + "%03d.png")],
            check=True, creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0))
    return "/__dir/" + prefix


def contents(a):
    """name → (the picture's URL, the picture after the cut): the text picture
    (--p7-text, copied into the run's directory) and the game screenshot of
    C:\\Test (01_4K.png, 0 A.D., CC BY-SA 3.0), each cutting to the other."""
    pics = {}
    if a.p7_text:
        name = "%s-src-text.png" % a.tag
        shutil.copyfile(a.p7_text, os.path.join(a.dir, name))
        pics["text"] = "/__dir/" + name
    pics["game"] = "/test/01_4K.png"
    clips = {}
    for item in (a.p7_video or "").split(","):
        if item:
            name, _, start = item.partition("=")
            clips[name] = clip_frames(a, name, float(start))
    wanted = [c for c in (a.p7_content or "text,game").split(",") if c]
    for c in wanted:
        if c not in pics and c not in clips:
            raise SystemExit("--p7-content %s: no picture (--p7-text for the text, --p7-video for a clip)" % c)
    others = {c: next((o for o in pics if o != c), c) for c in pics}
    # a clip: (its frames' prefix, None)
    return {c: (clips[c], None) if c in clips else (pics[c], pics[others[c]]) for c in wanted}


def run(a, run_page):
    """Every case × content × sequence, one page each; the results on disk,
    then the tables."""
    pics = contents(a)
    cases = [c for c in (a.p7_case or "x2,x133").split(",") if c]
    seqs = [s for s in (a.p7_seq or DEFAULT_SEQS).split(",") if s]
    q = lambda v: urllib.parse.quote(str(v), safe=":/,;=.")  # noqa: E731
    for case in cases:
        size_in, size_out = CASES[case]
        for content, (src, src2) in pics.items():
            for seq in seqs:
                if (src2 is None) != (seq in VIDEO_SEQS):
                    continue  # a clip plays its own sequences (vid), a picture the others
                segs, v, ov = SEQS[seq]
                name = "%s-%s-%s-%s" % (a.tag, case, content, seq)
                crop = CROP_OBJ if seq in ("obj", "tryobj") else CROP
                roi = ROI_OBJ if seq in ("obj", "tryobj") else ROI
                if (a.p7_roi or "auto") == "full":
                    roi = (0, 0) + tuple(map(int, size_out.split("x")))
                warm = WARM if a.p7_warm is None else a.p7_warm
                query = "&".join("%s=%s" % (k, q(val)) for k, val in [
                    ("seq", 1), ("in", size_in), ("out", size_out),
                    *([("vid", src)] if src2 is None else [("src", src), ("src2", src2)]),
                    ("box", ",".join(map(str, VID_BOX if src2 is None else BOX))), ("segs", segs), ("v", v), ("ov", ov),
                    ("kbps", a.p7_kbps or KBPS), ("vcodec", a.p7_vcodec or "avc"),
                    ("hist", a.p7_hist or HIST), ("dump", ",".join(map(str, dump_frames(segs)))),
                    ("crop", ",".join(map(str, crop))), ("roi", ",".join(map(str, roi))),
                    ("warm", warm), ("tag", name)])
                print("== %s" % name)
                sys.stdout.flush()
                res = run_page(query)
                with open(os.path.join(a.dir, name + ".json"), "w") as fh:
                    json.dump(res, fh, indent=1)
                if "error" in res:
                    print("  ERROR %s" % str(res["error"])[:1500])
                    sys.stdout.flush()
                    continue
                for kbps, s in res["streams"].items():
                    print("  %s kbit/s: %s, mean %s kbit/s (warm-up %s), Y PSNR %.2f dB, keys %s, dropped %s" % (
                        kbps, s["info"]["codec"], s["info"]["meanKbps"], s["info"].get("warmKbps"),
                        float(np.mean(s["psnrY"])), s["info"]["keys"], s["info"]["dropped"]))
                print("  %d frames in %.0f s" % (len(res["frames"]), res["seconds"]))
                sys.stdout.flush()
    table(a, a.tag)


# ── FLIP on the crops, in one process ───────────────────────────────────────

_FLIP_BATCH = '''
import json, sys
import numpy as np
import flip_evaluator as flip
out = []
for gt, img in json.load(open(sys.argv[1])):
    m, mean, _ = flip.evaluate(np.load(gt), np.load(img), "LDR")
    out.append([float(mean), float(np.percentile(m, 99))])
json.dump(out, open(sys.argv[2], "w"))
'''


def load_crop(path, w, h):
    raw = np.fromfile(path, dtype=np.uint8)
    if raw.size != w * h * 4:
        raise ValueError("%s: %d bytes, not %dx%dx4" % (path, raw.size, w, h))
    return raw.reshape(h, w, 4)[..., :3].astype(np.float32) / 255.0


def flip_batch(pairs):
    """[(gt array, output array)] → [(mean, p99)] or Nones: in process when
    the package imports, else one call of FLIP_PYTHON for the whole list."""
    if not pairs:
        return []
    if metrics.flip is not None:
        return [metrics.flip_ldr(g, o) for g, o in pairs]
    if not metrics.FLIP_PYTHON:
        return [(None, None)] * len(pairs)
    with tempfile.TemporaryDirectory() as d:
        lst = []
        for k, (g, o) in enumerate(pairs):
            pg, po = os.path.join(d, "g%d.npy" % k), os.path.join(d, "o%d.npy" % k)
            np.save(pg, np.ascontiguousarray(g))
            np.save(po, np.ascontiguousarray(o))
            lst.append([pg, po])
        listing, result = os.path.join(d, "pairs.json"), os.path.join(d, "flip.json")
        with open(listing, "w") as f:
            json.dump(lst, f)
        r = subprocess.run([metrics.FLIP_PYTHON, "-c", _FLIP_BATCH, listing, result],
                           capture_output=True, text=True, timeout=3600)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout)[-500:])
        with open(result) as f:
            return [tuple(x) for x in json.load(f)]


def flips(a, res, run):
    """FLIP of every dumped crop against its frame's truth, {(kbps, variant,
    t): mean}; the crops are named `<run>-f<t>-gt` and `<run>-f<t>-b<kbps>-<variant>`
    (the server keeps them as .f16, the extension of its raw posts)."""
    cw, ch = res["crop"][2], res["crop"][3]
    gts = {}
    jobs = []
    for name in res["dumped"]:
        path = os.path.join(a.dir, name + ".f16")
        if not name.startswith(run + "-f") or not os.path.exists(path):
            continue
        t, _, what = name[len(run) + 2:].partition("-")
        if what == "gt":
            gts[int(t)] = load_crop(path, cw, ch)
        else:
            kb, _, variant = what.partition("-")
            jobs.append(((int(kb[1:]), variant, int(t)), path))
    jobs = [(key, p) for key, p in jobs if key[2] in gts]
    vals = flip_batch([(gts[key[2]], load_crop(p, cw, ch)) for key, p in jobs])
    return {key: v[0] for (key, _), v in zip(jobs, vals)}


# ── the tables ──────────────────────────────────────────────────────────────

def psnr(mse):
    return 10 * math.log10(1.0 / max(mse, 1e-12))


def groups(frames):
    """Frame indices by role: the pan after a warm-up of three frames, the stop
    after its first frame (which still moved), the five frames from the cut
    (the trail), the rest after the cut, the block's crossing."""
    g = {"pan": [], "stop": [], "cut5": [], "after": [], "obj": []}
    cut = next((t for t, f in enumerate(frames) if f["seg"] in ("cut", "cutpan")), None)
    for t, f in enumerate(frames):
        if f["seg"] == "pan" and t >= 3:
            g["pan"].append(t)
        elif f["seg"] == "stop" and not f["first"]:
            g["stop"].append(t)
        elif f["seg"] in ("cut", "cutpan"):
            (g["cut5"] if t < cut + 5 else g["after"]).append(t)
        elif f["seg"] == "obj" and t >= 3:
            g["obj"].append(t)
    return g


def mean(xs):
    xs = [x for x in xs if x is not None]
    return float(np.mean(xs)) if xs else None


def summarise(res, fl):
    """Per bitrate and variant: the PSNR (mean of the frames' dB), the
    instability (|ΔE|, in 1/255 of the encoded value, all pixels and on the
    edges), the flicker of the stop (|Δout|), the wake's PSNR and FLIP, by
    role; against `none`, the deltas and ratios."""
    g = groups(res["frames"])
    out = {}
    for kbps, byv in res["metrics"].items():
        rows = {}
        for vname, m in byv.items():
            r = {}
            for role, ts in g.items():
                if not ts:
                    continue
                r[role] = {
                    "psnr": mean([psnr(m["mse"][t]) for t in ts]),
                    "psnrEdge": mean([psnr(m["mseEdge"][t]) if m["mseEdge"][t] else None for t in ts]),
                    "te": mean([m["te"][t] * 255 if m["te"][t] is not None else None for t in ts]),
                    "teEdge": mean([m["teEdge"][t] * 255 if m["teEdge"][t] is not None else None for t in ts]),
                    "oc": mean([m["oc"][t] * 255 if m["oc"][t] is not None else None for t in ts]),
                    "psnrRect": mean([psnr(m["mseRect"][t]) if m["mseRect"][t] else None for t in ts]),
                    "flip": mean([fl.get((int(kbps), vname, t)) for t in ts]),
                }
            rows[vname] = r
        base = rows.get("none", {})
        for vname, r in rows.items():
            for role, x in r.items():
                b = base.get(role, {})
                for k in ("psnr", "psnrEdge", "psnrRect", "flip"):
                    if x.get(k) is not None and b.get(k) is not None:
                        x["d_" + k] = x[k] - b[k]
                for k in ("te", "teEdge", "oc"):
                    if x.get(k) is not None and b.get(k):
                        x["r_" + k] = x[k] / b[k]
        out[kbps] = rows
    return out


def f(x, d=2, sign=False):
    if x is None:
        return "-"
    return ("%+.*f" if sign else "%.*f") % (d, x)


def gate(all_sums):
    """The verdict of §14.3 per variant, over every case, content and bitrate:
    on the slow pans (slow, mid) the mean PSNR delta (pan and stop) or FLIP
    delta, and the mean ratio of the instability on the edges; the worst
    PSNR delta of the fast ones (rapid's pan, every cut's five frames, the
    block's wake)."""
    acc = {}
    for (case, content, seq), sums in all_sums.items():
        for kbps, rows in sums.items():
            for vname, r in rows.items():
                if vname == "none":
                    continue
                v = acc.setdefault(vname, {"dpsnr": [], "dflip": [], "flick": [], "trail": []})
                if seq in SLOW:
                    for role in ("pan", "stop"):
                        if "d_psnr" in r.get(role, {}):
                            v["dpsnr"].append(r[role]["d_psnr"])
                        if "d_flip" in r.get(role, {}):
                            v["dflip"].append(r[role]["d_flip"])
                    if "r_teEdge" in r.get("pan", {}):
                        v["flick"].append(r["pan"]["r_teEdge"])
                if seq in FAST:
                    for role, k in (("pan", "d_psnr"), ("obj", "d_psnrRect")):
                        if k in r.get(role, {}):
                            v["trail"].append(r[role][k])
                if "d_psnr" in r.get("cut5", {}):
                    v["trail"].append(r["cut5"]["d_psnr"])
    verdict = {}
    for vname, v in acc.items():
        dp, df, fr = mean(v["dpsnr"]), mean(v["dflip"]), mean(v["flick"])
        worst = min(v["trail"]) if v["trail"] else None
        quality = (dp is not None and dp >= GATE["psnr"]) or (df is not None and df <= GATE["flip"])
        steady = fr is not None and fr <= GATE["flicker"]
        clean = worst is None or worst >= GATE["trail"]
        verdict[vname] = {"dpsnr": dp, "dflip": df, "flicker": fr, "worstTrail": worst,
                          "quality": quality, "steady": steady, "clean": clean,
                          "go": bool(quality and steady and clean)}
    return verdict


def bitrate_trade(all_sums, lo, hi):
    """Each variant at the lower bitrate against mwsr alone at the higher one,
    on the slow pans: the PSNR and FLIP deltas, the instability ratio — a
    history that holds there is bandwidth (the link's) for the same picture."""
    acc = {}
    for (case, content, seq), sums in all_sums.items():
        if seq not in SLOW or lo not in sums or hi not in sums:
            continue
        ref = sums[hi].get("none", {}).get("pan", {})
        for vname, r in sums[lo].items():
            x = r.get("pan", {})
            v = acc.setdefault(vname, {"dpsnr": [], "dflip": [], "flick": []})
            if x.get("psnr") is not None and ref.get("psnr") is not None:
                v["dpsnr"].append(x["psnr"] - ref["psnr"])
            if x.get("flip") is not None and ref.get("flip") is not None:
                v["dflip"].append(x["flip"] - ref["flip"])
            if x.get("teEdge") is not None and ref.get("teEdge"):
                v["flick"].append(x["teEdge"] / ref["teEdge"])
    return {k: {kk: mean(vv) for kk, vv in v.items()} for k, v in acc.items()}


def table(a, tag):
    """<dir>/<tag>-p7.md and -p7.json from the run's files."""
    all_sums = {}
    lines = ["# P7.0 — %s" % tag, "",
             "PSNR in dB (mean of the frames), FLIP on the dumped crops; |ΔE| the change of the "
             "luma's error from one frame to the next, |Δout| the output's change where the truth "
             "holds still, in 1/255; deltas and ratios against `none` (mwsr alone) at the same bitrate.", ""]
    for path in sorted(glob.glob(os.path.join(a.dir, "%s-*-*-*.json" % tag))):
        base = os.path.basename(path)[len(tag) + 1:-5]
        parts = base.split("-")
        if len(parts) != 3 or parts[0] not in CASES or parts[2] not in SEQS:
            continue
        case, content, seq = parts
        with open(path) as fh:
            res = json.load(fh)
        if "error" in res:
            lines += ["## %s · %s · %s" % (case, content, seq), "", "ERROR " + str(res["error"])[:400], ""]
            continue
        fl = flips(a, res, "%s-%s" % (tag, base))
        sums = summarise(res, fl)
        all_sums[(case, content, seq)] = sums
        streams = res["streams"]
        lines += ["## %s · %s · %s (%s → %s, v %s px/frame)" % (
            case, content, seq, res["params"]["in"], res["params"]["out"], res["params"]["v"]), "",
            "Region %s, warm-up %s frames · Adapter: %s · %s" % (
                res["params"].get("roi", "whole screen"), res["params"].get("warm", 0),
                res["adapter"]["name"], " · ".join(
                "%s kbit/s: %s %s, %s kbit/s measured, Y PSNR %.2f dB, keys %s" % (
                    k, s["info"]["codec"], s["info"]["acceleration"], s["info"]["meanKbps"],
                    float(np.mean(s["psnrY"])), s["info"]["keys"]) for k, s in streams.items())), ""]
        for kbps, rows in sums.items():
            lines += ["### %s kbit/s" % kbps, "",
                      "| variant | pan PSNR | Δ | pan FLIP | Δ | pan \\|ΔE\\| edges | ratio | stop \\|Δout\\| | ratio "
                      "| stop PSNR Δ | cut, 5 frames, PSNR Δ | wake PSNR Δ |",
                      "|---|---|---|---|---|---|---|---|---|---|---|---|"]
            for vname, r in rows.items():
                pan, stop, cut5, obj = (r.get(k, {}) for k in ("pan", "stop", "cut5", "obj"))
                head = pan or obj
                lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                    vname, f(head.get("psnr")), f(head.get("d_psnr"), 2, True), f(head.get("flip"), 4),
                    f(head.get("d_flip"), 4, True), f(head.get("teEdge")), f(head.get("r_teEdge")),
                    f(stop.get("oc"), 3), f(stop.get("r_oc")), f(stop.get("d_psnr"), 2, True),
                    f(cut5.get("d_psnr"), 2, True), f(obj.get("d_psnrRect"), 2, True)))
            lines.append("")
    verdict = gate(all_sums)
    kb = sorted({int(k) for s in all_sums.values() for k in s})
    trade = bitrate_trade(all_sums, str(kb[0]), str(kb[-1])) if len(kb) > 1 else {}
    lines += ["## The gate (§14.3; thresholds of the plan, Bruno's to fix)", "",
              "Slow pans (%s): PSNR Δ ≥ +%.1f dB or FLIP Δ ≤ %.3f, and the instability on the edges at most "
              "×%.1f; the fast ones (%s, and every cut's five frames): no PSNR Δ below %.1f dB." % (
                  ", ".join(SLOW), GATE["psnr"], GATE["flip"], GATE["flicker"], ", ".join(FAST), GATE["trail"]), "",
              "| variant | PSNR Δ | FLIP Δ | edge instability ratio | worst trail Δ | verdict |",
              "|---|---|---|---|---|---|"]
    for vname, v in verdict.items():
        lines.append("| %s | %s | %s | %s | %s | %s |" % (
            vname, f(v["dpsnr"], 2, True), f(v["dflip"], 4, True), f(v["flicker"]), f(v["worstTrail"], 2, True),
            "**go**" if v["go"] else "no (%s)" % ", ".join(
                k for k, ok in (("quality", v["quality"]), ("steadiness", v["steady"]), ("trail", v["clean"]))
                if not ok)))
    if trade:
        lines += ["", "## The bitrate: each variant at %d kbit/s against mwsr alone at %d (slow pans)" % (kb[0], kb[-1]),
                  "", "| variant | PSNR Δ | FLIP Δ | edge instability ratio |", "|---|---|---|---|"]
        for vname, v in trade.items():
            lines.append("| %s | %s | %s | %s |" % (vname, f(v["dpsnr"], 2, True), f(v["dflip"], 4, True), f(v["flick"])))
    md = os.path.join(a.dir, "%s-p7.md" % tag)
    with open(md, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    with open(os.path.join(a.dir, "%s-p7.json" % tag), "w") as fh:
        json.dump({"sums": {"-".join(k): v for k, v in all_sums.items()}, "gate": verdict, "trade": trade,
                   "thresholds": GATE}, fh, indent=1)
    print("wrote", md)
    for vname, v in verdict.items():
        print("  %-18s PSNR %s FLIP %s instability ×%s trail %s -> %s" % (
            vname, f(v["dpsnr"], 2, True), f(v["dflip"], 4, True), f(v["flicker"]), f(v["worstTrail"], 2, True),
            "GO" if v["go"] else "no"))
