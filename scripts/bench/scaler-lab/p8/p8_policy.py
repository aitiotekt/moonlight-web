"""P8.0 step 1: strength policies for the DCT shrinkage, judged on the second
sweep's per-frame results. A policy picks, per frame, one strength of the
grid T16; its result is that frame's measure at that strength.

  fixed T            the same T everywhere (blind, the simplest)
  qp k               T = k·Qstep(frame QP): what a host sending its QP gives
  nr a,b             T = a + b·(the picture's own block step): blind, adaptive
  oracle             the best T of each frame against the truth (the ceiling)
"""
import json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p8_offline import OUT

rows = json.load(open(os.path.join(OUT, "sweep2.json")))
KEYS = rows[0]["keys"]
I = {k: i for i, k in enumerate(KEYS)}
TS = [3, 4, 5, 6, 8, 12, 16]


def qstep(qp):
    return 0.625 * 2 ** (qp / 6.0)


def nearest(t):
    return min(TS, key=lambda x: abs(math.log(x) - math.log(max(t, 0.5))))


def frame_val(fr, name, key):
    v = fr["v"][name][I[key]]
    return v


def evaluate(policy):
    """→ {group: (dPSNR, dTex, R left, TR16 left, mean T)}"""
    groups = {}
    for r in rows:
        g = ("cod " + r["codec"]) if r["content"].startswith("cod") else r["content"].split("-")[0]
        for n, fr in enumerate(r["frames"]):
            name = policy(r, n, fr)
            if name is None:
                continue
            base = fr["v"]["none"]
            got = fr["v"][name]
            acc = groups.setdefault(g, {"dp": [], "dt": [], "rl": [], "tl": [], "t": []})
            acc["dp"].append(got[I["psnr"]] - base[I["psnr"]])
            acc["dt"].append(got[I["psnr_tex"]] - base[I["psnr_tex"]])
            if base[I["R"]] > 1.02:
                acc["rl"].append((got[I["R"]] - 1) / (base[I["R"]] - 1))
            if base[I["TR16"]] > 1.02:
                acc["tl"].append((got[I["TR16"]] - 1) / (base[I["TR16"]] - 1))
            if name.startswith("dct-T"):
                acc["t"].append(float(name[5:].split("c")[0]))
    mean = lambda xs: sum(xs) / len(xs) if xs else float("nan")
    return {g: (mean(a["dp"]), mean(a["dt"]), mean(a["rl"]), mean(a["tl"]), mean(a["t"])) for g, a in groups.items()}


ORDER = ["cod avc", "cod hevc", "cod av1", "text", "game"]


def show(label, res):
    line = "%-26s" % label
    for g in ORDER:
        x = res.get(g)
        line += "| %+5.2f %+5.2f %5.2f %5.2f %4.1f " % x if x else "| %27s " % "-"
    print(line)


print("%-26s" % "policy" + "".join("| %-27s" % g for g in ORDER))
print("%-26s" % "" + "| dPSNR  dTex Rleft TRlft  T  " * len(ORDER))
for name in ["edge-s2"] + ["dct-T%d" % t for t in TS] + ["dct-T4c2", "dct-T6c2", "dct-T8c2", "dct-T8c4", "dct-T12c4",
                                                        "dct8-T4", "dct8-T6", "dct8-T8"]:
    show(name, evaluate(lambda r, n, fr, name=name: name))
print()
for k in (0.2, 0.25, 0.3, 0.4, 0.5):
    show("qp k=%.2f (avc, hevc)" % k,
         evaluate(lambda r, n, fr, k=k: "dct-T%d" % nearest(k * qstep(r["qp"][n])) if r["qp"] else None))
print()
# the blind policy: the picture's own block step (nr) against the frame's best T
pairs = []
for r in rows:
    if not r["content"].startswith("cod"):
        continue
    for n, fr in enumerate(r["frames"]):
        best = max(TS, key=lambda t: fr["v"]["dct-T%d" % t][I["psnr"]])
        pairs.append((fr["nr"], best, r["qp"][n] if r["qp"] else None))
pairs.sort()
q = len(pairs) // 5
print("nr quintiles on CoD → mean best T (and mean QP where known):")
for i in range(5):
    chunk = pairs[i * q:(i + 1) * q]
    qs = [c[2] for c in chunk if c[2] is not None]
    print("  nr %.2f..%.2f: best T %.1f  QP %s" % (chunk[0][0], chunk[-1][0], sum(c[1] for c in chunk) / len(chunk),
                                                 "%.1f" % (sum(qs) / len(qs)) if qs else "-"))
for a, b in ((3, 2), (3, 4), (3, 6), (4, 4), (2, 6)):
    show("nr T=%g+%g*nr" % (a, b), evaluate(lambda r, n, fr, a=a, b=b: "dct-T%d" % nearest(a + b * max(fr["nr"], 0))))
print()
show("oracle (best T per frame)", evaluate(
    lambda r, n, fr: max(("dct-T%d" % t for t in TS), key=lambda nm: fr["v"][nm][I["psnr"]])))
