"""P8.0: the lab's gate (journal J43: set before the campaign, amended after the trial) on
the P7 tables of the tags (scaler_lab.py --p7-table <tag> writes
<dir>/<tag>-p7.json): p8c the stills, p8v the CoD clips.

  python -X utf8 p8_gate.py [tags=p8c,p8v] [dir]

1. Blocky cases (x2 at 4000, x133 at 6000 kbit/s), each case on its own, on
   the clips: the mean over the pan frames of both clips, dPSNR >= +0.1 dB or
   dFLIP <= -0.002.
2. Do no harm, each group on its own: x2 at 10000 and x133 at 12000 (every
   content), the text picture at every rate: dPSNR >= -0.05 dB and dFLIP <=
   +0.001.
3. Time: the stop's flicker (oc, the stills) and the pan's instability (te),
   the mean ratio against mwsr alone over every page and rate, at most x1.05.
"""
import json, os, sys

tags = (sys.argv[1] if len(sys.argv) > 1 else "p8c,p8v").split(",")
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
d = sys.argv[2] if len(sys.argv) > 2 else os.path.join(REPO, "bench-out", "scaler-lab", "p8", "lab")
sums = {}
for tag in tags:
    path = os.path.join(d, "%s-p7.json" % tag)
    if os.path.exists(path):
        sums.update(json.load(open(path))["sums"])
    else:
        print("(no %s)" % path)
LOW = {"x2": "4000", "x133": "6000"}
HIGH = {"x2": "10000", "x133": "12000"}
CLIPS = ("cloud", "boom")
G = {"psnr": 0.1, "flip": -0.002, "harm_psnr": -0.05, "harm_flip": 0.001, "time": 1.05}


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def pick(variant, cond, role, key):
    out = []
    for page, byk in sums.items():
        case, content, seq = page.split("-")
        for kbps, rows in byk.items():
            if cond(case, content, seq, kbps):
                out.append(rows.get(variant, {}).get(role, {}).get(key))
    return out


def f(x, d=2, sign=True):
    return "-" if x is None else (("%+.*f" if sign else "%.*f") % (d, x))


variants = sorted({v for byk in sums.values() for rows in byk.values() for v in rows if v != "none"})
groups1 = [("blocky %s@%s" % (c, k), lambda c_, ct, s, kb, c=c, k=k: c_ == c and kb == k and ct in CLIPS)
           for c, k in LOW.items()]
groups2 = [("high %s@%s" % (c, k), lambda c_, ct, s, kb, c=c, k=k: c_ == c and kb == k) for c, k in HIGH.items()]
groups2 += [("text %s@%s" % (c, k), lambda c_, ct, s, kb, c=c, k=k: c_ == c and kb == k and ct == "text")
            for c, k in list(LOW.items()) + list(HIGH.items())]
present = lambda cond: any(cond(*p.split("-"), kb) for p, byk in sums.items() for kb in byk)  # noqa: E731
groups1 = [(n, c) for n, c in groups1 if present(c)]
groups2 = [(n, c) for n, c in groups2 if present(c)]
everything = lambda *a: True  # noqa: E731

print("the gate of J43 on %s (%d pages); pan frames; dPSNR dB, dFLIP; time ratios vs none" % (",".join(tags), len(sums)))
print("%-16s" % "variant" + "".join("| %-21s" % n for n, _ in groups1 + groups2) + "| oc×   te×   teEdge× | verdict")
verdicts = {}
for v in variants:
    line = "%-16s" % v
    ok1, ok2 = True, True
    cells = {}
    for n, c in groups1:
        dp, df = mean(pick(v, c, "pan", "d_psnr")), mean(pick(v, c, "pan", "d_flip"))
        ok = (dp is not None and dp >= G["psnr"]) or (df is not None and df <= G["flip"])
        ok1 &= ok
        cells[n] = {"dpsnr": dp, "dflip": df, "ok": ok}
        line += "| %-6s %-8s %-4s " % (f(dp), f(df, 4), "ok" if ok else "NO")
    for n, c in groups2:
        dp, df = mean(pick(v, c, "pan", "d_psnr")), mean(pick(v, c, "pan", "d_flip"))
        ok = (dp is None or dp >= G["harm_psnr"]) and (df is None or df <= G["harm_flip"])
        ok2 &= ok
        cells[n] = {"dpsnr": dp, "dflip": df, "ok": ok}
        line += "| %-6s %-8s %-4s " % (f(dp), f(df, 4), "ok" if ok else "NO")
    oc = mean(pick(v, everything, "stop", "r_oc"))
    te = mean(pick(v, everything, "pan", "r_te"))
    tee = mean(pick(v, everything, "pan", "r_teEdge"))
    ok3 = (oc is None or oc <= G["time"]) and (te is None or te <= G["time"])
    line += "| %-5s %-5s %-7s " % (f(oc, 3, False), f(te, 3, False), f(tee, 3, False))
    go = bool(groups1) and ok1 and ok2 and ok3
    verdicts[v] = {"cells": cells, "oc": oc, "te": te, "teEdge": tee,
                   "blocky": ok1, "harm": ok2, "time": ok3, "go": go}
    line += "| " + ("GO" if go else "no (%s)" % ", ".join(k for k, ok in (("blocky", ok1 and bool(groups1)),
                                                                        ("harm", ok2), ("time", ok3)) if not ok))
    print(line)
json.dump(verdicts, open(os.path.join(d, "p8gate.json"), "w"), indent=1)
