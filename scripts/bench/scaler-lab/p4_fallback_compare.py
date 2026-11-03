"""The import fallback's cost: the P4 set run with importfail=1 (tag B) against
the gate's run with the import (tag A), on the same GPU. Per case, regime and
WebGPU pass: submit / done / gpu p50 of both runs and the ratio B / A; the
WebGL2 cells, untouched by importfail, give the run-to-run drift. Usage:
p4_fallback_compare.py <dir> <tagA> <tagB> [out.md]"""
import json
import os
import sys

d, ta, tb = sys.argv[1], sys.argv[2], sys.argv[3]
out = sys.argv[4] if len(sys.argv) > 4 else os.path.join(d, tb + "-fallback.md")
CASES = ["x2-text", "x2-game", "x2-ui", "x133-text", "x067-text"]
PASSES = ["off", "sgsr", "fsr1", "mwsr"]


def load(tag, case, regime):
    p = os.path.join(d, "%s-%s%s.json" % (tag, case, "-tick" if regime == "tick" else ""))
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        r = json.load(f)
    return {c["name"]: c for c in r.get("cells", [])}, r


def st(c, key, q="p50"):
    v = (c.get(key) or {}).get(q)
    return v if isinstance(v, (int, float)) else None


def fmt(v):
    return "-" if v is None else "%.3f" % v


def rat(x, y):
    return None if x is None or not y else x / y


def frat(v):
    return "-" if v is None else "%.2f" % v


lines = ["# Coût du repli d'import — %s (bitmap) contre %s (import)" % (tb, ta), ""]
adapters = set()
nl = os.linesep
rows_gpu, rows_gl = [], []
summary = {}
for case in CASES:
    for regime in ("back", "tick"):
        A, B = load(ta, case, regime), load(tb, case, regime)
        if A is None or B is None:
            lines.append("- %s %s: missing run (%s / %s)" % (case, regime, A is not None, B is not None))
            continue
        for run in (A, B):
            adapters.add((run[1].get("adapter") or {}).get("name", "?"))
        errsB = len(B[1].get("errors") or [])
        for p in PASSES:
            ca, cb = A[0].get("chain-" + p), B[0].get("chain-" + p)
            if ca is None or cb is None:
                continue
            rows_gpu.append((case, regime, p, st(ca, "submit"), st(cb, "submit"), st(ca, "done"), st(cb, "done"),
                             st(ca, "done", "p99"), st(cb, "done", "p99"), st(ca, "gpu"), st(cb, "gpu"),
                             cb.get("copies"), errsB))
            summary.setdefault((regime, p), []).append(rat(st(cb, "done"), st(ca, "done")))
            ga, gb = A[0].get("chain-gl-" + p), B[0].get("chain-gl-" + p)
            if ga is not None and gb is not None:
                rows_gl.append((case, regime, p, st(ga, "done"), st(gb, "done"), st(ga, "gpu"), st(gb, "gpu")))

lines += ["Adapters: %s" % ", ".join(sorted(adapters)), "",
          "WebGPU chain, `submit` / `done` / `gpu` p50 in ms: A = the import (gate run), B = the ImageBitmap copy "
          "(importfail=1). `done` is draw() to the GPU's completion, the bitmap's creation and copy included.", "",
          "| case | regime | pass | submit A | submit B | done A | done B | done B/A | done p99 A | done p99 B | gpu A | gpu B | gpu B/A | errors B |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
for (case, regime, p, sa, sb, da, db, da99, db99, ga, gb, copies, errs) in rows_gpu:
    lines.append("| %s | %s | `%s` | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
        case, regime, p, fmt(sa), fmt(sb), fmt(da), fmt(db), frat(rat(db, da)), fmt(da99), fmt(db99),
        fmt(ga), fmt(gb), frat(rat(gb, ga)), errs or ""))
lines += ["", "WebGL2 chain, the same two runs (the control: importfail=1 does not touch it, so B/A is the drift between the runs).", "",
          "| case | regime | pass | done A | done B | done B/A | gpu A | gpu B |", "|---|---|---|---|---|---|---|---|"]
for (case, regime, p, da, db, ga, gb) in rows_gl:
    lines.append("| %s | %s | `%s` | %s | %s | %s | %s | %s |" % (case, regime, p, fmt(da), fmt(db), frat(rat(db, da)), fmt(ga), fmt(gb)))
lines += ["", "## Summary: done p50 B/A per pass (min-max over the cases)", ""]
for (regime, p), vals in sorted(summary.items()):
    vals = [v for v in vals if v is not None]
    if vals:
        lines.append("- %s `%s`: %.2f-%.2f (median %.2f)" % (regime, p, min(vals), max(vals), sorted(vals)[len(vals) // 2]))
lines.append("")
with open(out, "w", encoding="utf-8") as f:
    f.write(nl.join(lines))
sys.stdout.reconfigure(encoding="utf-8")
print(nl.join(lines))
print("wrote", out)
