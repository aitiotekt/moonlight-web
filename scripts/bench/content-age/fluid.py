"""How smooth a pass was, frame by frame (plan « inputadmit », 13/10/2026).

The admission window after a press (core/InputAdmit.h) sends a few pictures
more around each click. Its gate G1 asks for no visible artefact and nothing
that harms the stream's smoothness, so a pass is read here as the client lived
it, from the files a content-age pass leaves in bench-out/content-age:

  <tag>.frames.csv, <tag>.clicks.frames.csv   the client's frames (pass.py)
  <tag>.raf.csv          the page's animation frames over the clicks (pass.py --raflog)
  <tag>.relay.csv        the relay's frame log (relaylog=1)
  <tag>.click-trace.csv  the host's trace (clicktrace=1); its `admit` rows say
                         which pictures the window added
  <tag>.json             the clicks' moments (the probe's samples)

What it says, per pass and pooled over each glob:
  arrive   the gaps between frames arriving at the client: p1/p50/p99, and those
           over 25 ms; with the host's admit rows, the grid's frames alone too
  draw     the gaps between draws; with raf.csv, the refreshes that drew two
           frames or more (a client that tears shows each as it comes)
  shown    with raf.csv, what a client that paints at its vsync showed at each
           refresh (the last frame drawn before it): repeats, double steps (1.75
           intervals or more), steps off the stream's pattern (3 ms or more from
           a whole number of intervals), around the clicks (40 ms before, 60
           after) and elsewhere
  age      how much the age at draw (drawn - present) moves from one frame to the
           next: what a client that tears sees as uneven motion
  bytes    per frame, p50/p99, the window's and the grid's
  relay    the relay's outcomes; the frames it sent that the client never drew
           (dropped as stale, or lost)

    python fluid.py "c60-um-A[0-9]-*" "c60-um-A'[0-9]-*" [--clicks-only] [--fps 60]
"""
import argparse
import bisect
import csv
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "clickpath"))
import hostpath  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), "bench-out", "content-age")


def num(v):
    return hostpath.num(v)


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else float("nan")


def rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="") as f:
        return [{k: num(v) if k not in ("kind", "status", "outcome") else v for k, v in r.items()}
                for r in csv.DictReader(f)]


class Pass:
    def __init__(self, base, clicks_only):
        self.tag = os.path.basename(base)
        logs = [".clicks.frames.csv"] if clicks_only else [".frames.csv", ".clicks.frames.csv"]
        # Each log is a stretch of its own: no gap is counted across two.
        self.logs = []
        for suffix in logs:
            fr = [r for r in rows(base + suffix) if r.get("drawnMs") is not None and r.get("hostMs")]
            if fr:
                self.logs.append(sorted(fr, key=lambda r: r["drawnMs"]))
        self.raf = [r["frameMs"] for r in rows(base + ".raf.csv")]
        self.relay = rows(base + ".relay.csv")
        trace = rows(base + ".click-trace.csv")
        self.present = sorted(r["presentUs"] for r in trace
                              if r.get("kind") == "capture" and r.get("status") == "ok" and r.get("presentUs"))
        # The host's word on each picture it encoded (plan « inputadmit »):
        # status "grid" or "window", presentUs the picture's present.
        self.admitted = {int(r["presentUs"]): r["status"] for r in trace
                         if r.get("kind") == "admit" and r.get("presentUs")}
        self.clicks = []
        if os.path.exists(base + ".json"):
            c = json.load(open(base + ".json")).get("clicks") or {}
            org = c.get("timeOrigin")
            if org is not None:
                self.clicks = sorted(s["ts"] / 1000 - org for s in c.get("samples") or [])
        self.kind_of = {}
        if self.admitted and self.present:
            # The client's stamp is the present less under a millisecond
            # (hostpath.stamp_offset): each frame joined to its present.
            for fr in self.logs:
                x = hostpath.stamp_offset([r["hostMs"] for r in fr], self.present)
                for r in fr:
                    lo = r["hostMs"] * 1000 + x
                    j = bisect.bisect_left(self.present, lo)
                    if j < len(self.present) and self.present[j] < lo + 1000:
                        r["presentUs"] = self.present[j]
                        self.kind_of[id(r)] = self.admitted.get(self.present[j], "grid")


def gaps(seq):
    return [b - a for a, b in zip(seq, seq[1:])]


def stretch_gaps(p, key, keep=None):
    out = []
    for fr in p.logs:
        sel = [r for r in fr if keep is None or keep(r)]
        vals = sorted(r[key] for r in sel if r.get(key) is not None)
        out += gaps(vals)
    return out


def near_click(p, t, before=40.0, after=60.0):
    """The click whose moment is at most @p before ms after @p t or @p after ms
    before it (its index), or None."""
    i = bisect.bisect_right(p.clicks, t + before) - 1
    return i if i >= 0 and p.clicks[i] >= t - after else None


def shown_steps(p, interval_ms):
    """At each animation frame, the content (hostMs) of the last frame drawn
    before it; the step from the refresh before, near a click or not."""
    out = {"click": [], "else": [], "by_click": {}}
    for fr in p.logs:
        drawn = [r["drawnMs"] for r in fr]
        content = [r["hostMs"] for r in fr]
        lo, hi = drawn[0], drawn[-1]
        prev = None
        for t in p.raf:
            if not lo <= t <= hi:
                prev = None
                continue
            k = bisect.bisect_left(drawn, t) - 1
            if k < 0:
                continue
            if prev is not None:
                c = near_click(p, t)
                out["click" if c is not None else "else"].append(content[k] - prev)
                if c is not None:
                    out["by_click"].setdefault(c, []).append(content[k] - prev)
            prev = content[k]
    return out


def step_counts(steps, interval_ms):
    n = len(steps) or 1
    rep = sum(1 for s in steps if s == 0)
    dbl = sum(1 for s in steps if s >= 1.75 * interval_ms)
    off = sum(1 for s in steps if s and abs(s - round(s / interval_ms) * interval_ms) > 3)
    return 100.0 * rep / n, 100.0 * dbl / n, 100.0 * off / n, len(steps)


def draws_per_refresh(p):
    """How many frames each refresh interval of the page drew."""
    hist = {}
    for fr in p.logs:
        drawn = [r["drawnMs"] for r in fr]
        lo, hi = drawn[0], drawn[-1]
        for a, b in zip(p.raf, p.raf[1:]):
            if a < lo or b > hi:
                continue
            k = bisect.bisect_left(drawn, b) - bisect.bisect_left(drawn, a)
            hist[min(k, 3)] = hist.get(min(k, 3), 0) + 1
    return hist


def report(label, passes, interval_ms):
    frames = [r for p in passes for fr in p.logs for r in fr]
    secs = sum((fr[-1]["drawnMs"] - fr[0]["drawnMs"]) / 1000 for p in passes for fr in p.logs) or 1
    arrive = [g for p in passes for g in stretch_gaps(p, "arrivedMs")]
    draw = [g for p in passes for g in stretch_gaps(p, "drawnMs")]
    print("%s: %d passes, %d frames drawn over %.0f s (%.2f a second)" % (
        label, len(passes), len(frames), secs, len(frames) / secs))
    print("  arrive  gaps p1 %.2f p50 %.2f p99 %.2f ms, over 25 ms: %d" % (
        q(arrive, .01), q(arrive, .5), q(arrive, .99), sum(1 for g in arrive if g > 25)))
    if any(p.kind_of for p in passes):
        # Every frame but the window's: one the host's rows did not name is the grid's.
        grid = [g for p in passes
                for g in stretch_gaps(p, "arrivedMs", lambda r, p=p: p.kind_of.get(id(r)) != "window")]
        n_win = sum(1 for p in passes for v in p.kind_of.values() if v == "window")
        print("          the grid's alone p1 %.2f p50 %.2f p99 %.2f ms, over 25 ms: %d; the window's "
              "frames: %d (%.2f a second)" % (q(grid, .01), q(grid, .5), q(grid, .99),
                                              sum(1 for g in grid if g > 25), n_win, n_win / secs))
    print("  draw    gaps p1 %.2f p50 %.2f p99 %.2f ms, over 25 ms: %d" % (
        q(draw, .01), q(draw, .5), q(draw, .99), sum(1 for g in draw if g > 25)))
    if any(p.raf for p in passes):
        hist = {}
        for p in passes:
            for k, v in draws_per_refresh(p).items():
                hist[k] = hist.get(k, 0) + v
        tot = sum(hist.values()) or 1
        print("          refreshes that drew 0 / 1 / 2 / 3+ frames: %s" % " / ".join(
            "%.1f %%" % (100.0 * hist.get(k, 0) / tot) for k in range(4)))
        steps = {"click": [], "else": []}
        by_click = []
        for p in passes:
            s = shown_steps(p, interval_ms)
            steps["click"] += s["click"]
            steps["else"] += s["else"]
            by_click += list(s["by_click"].values())
        for where in ("click", "else"):
            rep, dbl, off, n = step_counts(steps[where], interval_ms)
            print("  shown   %-5s %6d refreshes: repeats %.2f %%, double steps %.2f %%, off the pattern "
                  "%.2f %%" % ("near clicks" if where == "click" else "elsewhere", n, rep, dbl, off))
        if by_click:
            # Per click, 40 ms before it to 60 ms after: a picture held (a
            # repeat: at the stream's own rate, a stutter), a double step, the
            # steps off the pattern.
            n = len(by_click)
            rep = sum(1 for s in by_click if any(x == 0 for x in s))
            dbl = sum(1 for s in by_click if any(x >= 1.75 * interval_ms for x in s))
            off = sum(sum(1 for x in s if x and abs(x - round(x / interval_ms) * interval_ms) > 3)
                      for s in by_click)
            print("          per click (%d): a repeat in %.1f %%, a double step in %.1f %%, %.2f steps "
                  "off the pattern" % (n, 100.0 * rep / n, 100.0 * dbl / n, off / n))
    age = []
    for p in passes:
        for fr in p.logs:
            a = [r["drawnMs"] - r["hostMs"] for r in fr]
            age += [abs(y - x) for x, y in zip(a, a[1:])]
    print("  age     change from one frame to the next p50 %.2f p90 %.2f p99 %.2f ms, over 4 ms: %.2f %%" % (
        q(age, .5), q(age, .9), q(age, .99), 100.0 * sum(1 for x in age if x > 4) / (len(age) or 1)))
    sizes = [r["bytes"] for r in frames if r.get("bytes") and not r.get("key")]
    line = "  bytes   deltas p50 %.0f p99 %.0f" % (q(sizes, .5), q(sizes, .99))
    if any(p.kind_of for p in passes):
        for k in ("grid", "window"):
            s = [r["bytes"] for p in passes for fr in p.logs for r in fr
                 if p.kind_of.get(id(r)) == k and r.get("bytes") and not r.get("key")]
            line += "; %s p50 %.0f p99 %.0f" % (k, q(s, .5), q(s, .99))
    print(line)
    relay = [r for p in passes for r in p.relay]
    if relay:
        outcomes = {}
        for r in relay:
            outcomes[r["outcome"]] = outcomes.get(r["outcome"], 0) + 1
        # The frames the relay sent that no client log has: their present,
        # to the ms, against every hostMs the client drew.
        missing = 0
        for p in passes:
            have = {int(r["hostMs"]) for fr in p.logs for r in fr}
            lo = min((fr[0]["hostMs"] for fr in p.logs), default=None)
            hi = max((fr[-1]["hostMs"] for fr in p.logs), default=None)
            for r in p.relay:
                if r["outcome"] != "sent" or lo is None:
                    continue
                ms = int(r["captureUs"] // 1000)
                if lo <= ms <= hi and not ({ms - 1, ms, ms + 1} & have):
                    missing += 1
        print("  relay   %s; sent and never drawn: %d (%.2f a minute)" % (
            ", ".join("%s %d" % kv for kv in sorted(outcomes.items())), missing, missing / secs * 60))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("globs", nargs="+", help="one glob of pass tags per arm")
    ap.add_argument("--dir", default=OUT)
    ap.add_argument("--clicks-only", action="store_true", help="the clicks' minute alone")
    ap.add_argument("--fps", type=float, default=60, help="the stream's rate, for the steps' pattern")
    a = ap.parse_args()
    for g in a.globs:
        bases = sorted({f[:-len(".clicks.frames.csv")] for f in glob.glob(os.path.join(a.dir, g + ".clicks.frames.csv"))})
        if not bases:
            print("%s: no pass" % g)
            continue
        report(g, [Pass(b, a.clicks_only) for b in bases], 1000.0 / a.fps)
        print()


if __name__ == "__main__":
    main()
