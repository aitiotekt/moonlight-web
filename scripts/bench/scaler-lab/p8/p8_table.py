"""P8.0 step 1: the sweep's tables. Deltas against no filter, per stream;
then per family the fixed strength that does best over all streams, and the
best per stream (an oracle of the strength)."""
import json, math, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p8_offline import OUT

rows = json.load(open(os.path.join(OUT, "sweep.json")))
enc = {(e["content"], e["size"], e["codec"], e["kbps"]): e for e in json.load(open(os.path.join(OUT, "encodes.json")))}
fams = defaultdict(list)
for name in rows[0]["variants"]:
    if name != "none":
        fams[name.split("-T")[0].split("-s")[0]].append(name)


def d(r, name, k):
    a, b = r["variants"].get(name, {}).get(k), r["variants"]["none"].get(k)
    return None if a is None or b is None else a - b


def excess(r, name, k):
    """How much of the grid excess (R - 1) is left: 1 = untouched, 0 = gone."""
    a, b = r["variants"].get(name, {}).get(k), r["variants"]["none"].get(k)
    return None if a is None or b is None or b <= 1.02 else (a - 1) / (b - 1)


def mean(xs):
    xs = [x for x in xs if x is not None and not math.isnan(x)]
    return sum(xs) / len(xs) if xs else float("nan")


groups = {
    "cod avc": [r for r in rows if r["content"].startswith("cod") and r["codec"] == "avc"],
    "cod hevc": [r for r in rows if r["content"].startswith("cod") and r["codec"] == "hevc"],
    "cod av1": [r for r in rows if r["content"].startswith("cod") and r["codec"] == "av1"],
    "text": [r for r in rows if r["content"] == "text-pan"],
    "game": [r for r in rows if r["content"] == "game-pan"],
}
print("Mean deltas against no filter (PSNR dB; R and TR: share of the grid excess left)")
print("%-22s" % "variant" + "".join("| %-27s" % g for g in groups))
print("%-22s" % "" + "| dPSNR  dTex   R-left TR " * len(groups))
for fam, names in fams.items():
    for name in names:
        line = "%-22s" % name
        for g, rs in groups.items():
            line += "| %+5.2f %+5.2f  %5.2f %5.2f " % (
                mean(d(r, name, "psnr") for r in rs), mean(d(r, name, "psnr_tex") for r in rs),
                mean(excess(r, name, "R") for r in rs), mean(excess(r, name, "TR16") for r in rs))
        print(line)
    print()

print("Per stream, the best strength of each family by PSNR (oracle), and the best fixed one")
for fam, names in fams.items():
    if len(names) < 2:
        continue
    tot = {n: mean(d(r, n, "psnr") for r in rows if r["content"].startswith("cod")) for n in names}
    best_fixed = max(tot, key=lambda n: tot[n])
    print("%-12s best fixed on CoD: %s (%+.3f dB mean)" % (fam, best_fixed, tot[best_fixed]))
    for r in rows:
        if not r["content"].startswith("cod") or r["codec"] != "avc":
            continue
        b = max(names, key=lambda n: d(r, n, "psnr") if d(r, n, "psnr") is not None else -9)
        e = enc[(r["content"], r["size"], r["codec"], r["kbps"])]
        print("   %-10s %-4s %5d (%5.2f Mbit/s, QP %s): best %-10s %+.3f dB, R left %.2f; fixed %+.3f" % (
            r["content"], r["size"], r["kbps"], e["mbps"], "%.1f" % r["qp"] if r["qp"] else "-",
            b, d(r, b, "psnr"), excess(r, b, "R") or float("nan"), d(r, best_fixed, "psnr")))
