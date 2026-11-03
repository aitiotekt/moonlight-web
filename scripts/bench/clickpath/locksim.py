"""Plan « glissade » (14/10/2026): today's gate against the gate locked on the
display's presents, replayed on the host's traces, per family of passes.

Today's gate keeps its grid in whole microseconds (16 666 for 60 fps), so on
the virtual display at 240 Hz it slips some 36 µs a second along the presents:
every two minutes or so a window's edge lies on a present, and for ~30 s the
gaps between pictures go 12.5 / 20.8 ms instead of 16.7 (bench §8w.8). The
locked gate (gatesim.py --lock) keeps its windows' edges halfway between two
presents of a lattice that follows the display.

Each pass's captures (clicktrace=1) go through both copies of the host's gate,
in the loop's order (gatesim.gate_calls): gatesim.Gate, and the same locked on
a gatesim.Lattice fed each present first. Per family and gate:
  steps      the gaps between two carried pictures off the stream's interval by
             more than 3/4 of a display period (a whole refresh early or late),
             in % of the gaps; "content" when the refresh the gate wanted had
             no present, "gate" for the others;
  carried/s  the pictures carried a second;
  wait       how long a new picture waits for the next carried one, averaged
             over every instant (what a change at a random moment pays);
  lock       engagements a pass; once the content is dense (the first of three
             seconds in a row with presents at 80 % of the display's rate at
             least: the burst a stream starts with is not one), how long
             the lattice took to engage and the share of the gate's calls the
             locked gate decided; the passes never engaged. Before dense
             content a pass can present off the display's lattice (a page at
             60 fps on the virtual display: presents spread over the whole
             period), and the guard then rightly leaves today's gate.
The "vsync" family replays the passes of a client that paints on its vsync
with the exact interval of their aligned cadence (CadenceAlign.h), 0 and
±15 ppm off the client's real refresh, as the host's measure of it can be.

    python scripts/bench/clickpath/locksim.py [--family dense,vsync] [--passes]
"""
import argparse
import bisect
import csv
import glob
import os

import gatesim

OUT = os.path.join("bench-out", "content-age")

# The families of the plan's table, as the night of 14/10/2026 replayed them.
FAMILIES = (
    ("dense", "dense content (CoD's band, 60 and 120 fps)", ("ia-um-*", "ia-n95-[AB]*", "c60-um-A*")),
    ("target", "mw-click-target at 240 fps", ("u14att-*aw2*v240*",)),
    ("game", "RE9 (62 to 154 presents a second)", ("u14att-*re9rt*", "u14att-*re9-vis-r3*", "u14cad-*re9-f60*")),
    ("clock", "the test clock at 60 fps", ("u14cad-*clk-f60*",)),
    ("linux", "Linux, ScreenCast portal (out of the chapter)", ("al2-lx-vdd240-r*", "al3-*")),
    ("mac", "macOS, ScreenCaptureKit (out of the chapter)", ("am2-mac-vdd-240*",)),
)
VSYNC = ("ia-um-vA1", "ia-um-vA2", "ia-um-vB1", "ia-um-vB2", "ia-um-v6A1", "ia-um-v6A2", "ia-um-v6B1",
         "ia-um-v6B2", "ia-um-v12A1", "ia-um-v12A2", "ia-um-v12B1", "ia-um-v12B2", "ia-n95-vA1", "ia-n95-vB1")
VSYNC_PPM = (0, 15, -15)


class Pass:
    def __init__(self, base):
        self.base = base
        self.tag = os.path.basename(base)
        self.fps, self.hz = gatesim.pass_rates(base)
        self.period_ns = gatesim.lattice_period_ns(base, self.hz) if self.hz else 0
        rows = list(csv.DictReader(open(base + ".click-trace.csv")))
        self.calls = gatesim.gate_calls(rows, gatesim.pointer_drawn_in(base))
        self.presents = sorted(own for _, own, present in self.calls if present)
        self.dense_us = None
        if self.hz:
            def dense(at_us):
                i = bisect.bisect_left(self.presents, at_us)
                return bisect.bisect_left(self.presents, at_us + 1000000) - i >= 0.8 * self.hz
            for p in self.presents:
                if dense(p) and dense(p + 1000000) and dense(p + 2000000):
                    self.dense_us = p
                    break

    def usable(self):
        return self.fps and self.hz and self.fps < self.hz and len(self.presents) >= 1000


def refreshes(presents, period_us, gain=1 / 32):
    """Each present's refresh, counted from the first by a phase loop of its
    own: what a carried picture's step is judged on."""
    phase, slot, out = None, 0, {}
    for p in presents:
        if phase is not None:
            k = round((p - phase) / period_us)
            predicted = phase + k * period_us
            phase = predicted + gain * max(-period_us / 4, min(period_us / 4, p - predicted))
            slot += k
        else:
            phase = p
        out[p] = slot
    return out


def judge(ps, said, interval_us, period_us, slots, have):
    """The carried presents' steps, rate and wait, from the gate's word on
    each call."""
    carried = sorted(own for (_, own, present), ok in zip(ps.calls, said) if present and ok)
    n = round(interval_us / period_us)
    steps = content = 0
    for x, y in zip(carried, carried[1:]):
        gap = y - x
        if abs(gap - interval_us) <= 0.75 * period_us:
            continue
        steps += 1
        if gap > interval_us and slots[x] + n not in have:
            content += 1
    gaps = max(1, len(carried) - 1)
    span = (ps.presents[-1] - ps.presents[0]) / 1e6
    # The wait of each instant for the next carried picture, weighted by time.
    taken = set(carried)
    following, weighted, total = None, 0.0, 0.0
    for i in range(len(ps.presents) - 1, 0, -1):
        p = ps.presents[i]
        if p in taken:
            following = p
        if following is None:
            continue
        seg = p - ps.presents[i - 1]
        weighted += seg * (following - p)
        total += seg
    return {"steps": 100.0 * steps / gaps, "content": 100.0 * content / gaps,
            "gate": 100.0 * (steps - content) / gaps, "rate": len(carried) / span,
            "wait": weighted / total / 1000 if total else 0.0}


def replay(ps, interval_ns=None):
    """Today's gate and the locked one on a pass: (today, lock, lattice, gate)."""
    period_us = 1e6 / ps.hz
    interval_us = interval_ns / 1000 if interval_ns else 1e6 / ps.fps
    slots = refreshes(ps.presents, period_us)
    have = set(slots.values())
    today = gatesim.Gate(ps.fps, ps.hz, interval_ns=interval_ns)
    said = [today.admit(now) for now, _, _ in ps.calls]
    r0 = judge(ps, said, interval_us, period_us, slots, have)
    gate = gatesim.Gate(ps.fps, ps.hz, interval_ns=interval_ns)
    lattice = gatesim.Lattice(ps.period_ns)
    said, after, locked_after, engaged_us = [], 0, 0, None
    for now, own, present in ps.calls:
        if present:
            lattice.note(own * 1000)
        before = gate.locked_calls
        said.append(gate.admit(now, own, lattice))
        if ps.dense_us is not None and own >= ps.dense_us:
            after += 1
            locked_after += gate.locked_calls - before
            if engaged_us is None and lattice.engaged:
                engaged_us = own
    r1 = judge(ps, said, interval_us, period_us, slots, have)
    r1["engagements"] = lattice.engagements
    r1["never"] = lattice.first_engaged_ns is None
    # Once the content is dense: how long until the lattice engaged, and how
    # much of the gate's work it then did.
    r1["first"] = (engaged_us - ps.dense_us) / 1e6 if engaged_us is not None else None
    r1["locked"] = 100.0 * (locked_after / after if after else gate.locked_calls / max(1, gate.calls))
    r1["lockable"] = bool(gate.lock_ratio(lattice.period_ns))
    return r0, r1


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def report(name, title, results, a):
    """One family's line, today against the lock, and its worst pass."""
    if not results:
        print("%-7s no pass" % name)
        return
    r0s = [r0 for _, r0, _ in results]
    r1s = [r1 for _, _, r1 in results]
    first = [r1["first"] for r1 in r1s if r1["first"] is not None]
    never = sum(1 for r1 in r1s if r1["never"])
    print("%-7s %3d passes | steps %5.2f %% (content %5.2f, gate %5.2f) -> %5.2f %% (content %5.2f, gate %5.2f) | "
          "%6.2f -> %6.2f carried/s | wait %5.2f -> %5.2f ms | %4.1f engagements a pass, dense content "
          "engaged after %s s, %d never, %5.1f %% of calls locked | %s" % (
              name, len(results), mean([r["steps"] for r in r0s]), mean([r["content"] for r in r0s]),
              mean([r["gate"] for r in r0s]), mean([r["steps"] for r in r1s]),
              mean([r["content"] for r in r1s]), mean([r["gate"] for r in r1s]),
              mean([r["rate"] for r in r0s]), mean([r["rate"] for r in r1s]),
              mean([r["wait"] for r in r0s]), mean([r["wait"] for r in r1s]),
              mean([r1["engagements"] for r1 in r1s]),
              "%.2f to %.2f" % (min(first), max(first)) if first else "-", never,
              mean([r1["locked"] for r1 in r1s]), title))
    worst = max(results, key=lambda x: x[1]["steps"])
    print("        worst pass today: %s, %.1f %% -> %.1f %%" % (worst[0], worst[1]["steps"], worst[2]["steps"]))
    if a.passes:
        for tag, r0, r1 in results:
            print("        %-62s steps %5.1f -> %5.1f (gate %4.1f -> %4.1f) %6.2f -> %6.2f/s, wait %5.2f -> %5.2f, "
                  "%d eng., first %s, %5.1f %% locked%s" % (
                      tag[:62], r0["steps"], r1["steps"], r0["gate"], r1["gate"], r0["rate"], r1["rate"],
                      r0["wait"], r1["wait"], r1["engagements"],
                      "-" if r1["first"] is None else "%.2f s" % r1["first"], r1["locked"],
                      "" if r1["lockable"] else " (no whole number of periods)"))


def family(patterns, a):
    seen, out = set(), []
    for pat in patterns:
        for f in sorted(glob.glob(os.path.join(a.dir, pat + ".click-trace.csv"))):
            base = f[:-len(".click-trace.csv")]
            if base in seen:
                continue
            seen.add(base)
            ps = Pass(base)
            if not ps.usable():
                continue
            r0, r1 = replay(ps)
            out.append((ps.tag.replace("-v0-client-r0", ""), r0, r1))
    return out


def vsync(a):
    """The passes of a client on its vsync, with their aligned cadence's exact
    interval: the range over passes and measure errors."""
    lo0 = hi0 = lo1 = hi1 = None
    rows = []
    for tag in VSYNC:
        base = os.path.join(a.dir, tag + "-v0-client-r0")
        if not os.path.exists(base + ".click-trace.csv"):
            continue
        ps = Pass(base)
        if not ps.usable():
            continue
        for ppm in VSYNC_PPM:
            interval_ns = round(1e9 / ps.fps * (1 + ppm * 1e-6))
            r0, r1 = replay(ps, interval_ns)
            rows.append((tag, ppm, r0, r1))
            lo0 = r0["steps"] if lo0 is None else min(lo0, r0["steps"])
            hi0 = r0["steps"] if hi0 is None else max(hi0, r0["steps"])
            lo1 = r1["steps"] if lo1 is None else min(lo1, r1["steps"])
            hi1 = r1["steps"] if hi1 is None else max(hi1, r1["steps"])
    if not rows:
        print("vsync   no pass")
        return
    print("vsync   %3d passes x %d measure errors | steps %.1f to %.1f %% -> %.1f to %.1f %% | "
          "a client on its vsync, the aligned cadence's exact interval" % (
              len(rows) // len(VSYNC_PPM), len(VSYNC_PPM), lo0, hi0, lo1, hi1))
    if a.passes:
        for tag, ppm, r0, r1 in rows:
            print("        %-14s %+3d ppm  steps %5.1f -> %5.1f (gate %4.1f -> %4.1f)  %6.2f -> %6.2f/s" % (
                tag, ppm, r0["steps"], r1["steps"], r0["gate"], r1["gate"], r0["rate"], r1["rate"]))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", default=OUT)
    ap.add_argument("--family", default=",".join([f[0] for f in FAMILIES] + ["vsync"]),
                    help="the families to replay (default: all)")
    ap.add_argument("--passes", action="store_true", help="a line per pass as well")
    a = ap.parse_args()
    wanted = a.family.split(",")
    for name, title, patterns in FAMILIES:
        if name in wanted:
            report(name, title, family(patterns, a), a)
    if "vsync" in wanted:
        vsync(a)


if __name__ == "__main__":
    main()
