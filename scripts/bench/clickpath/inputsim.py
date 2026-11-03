"""The admission window after a press, replayed (plan « inputadmit », phase 0, 13/10/2026).

At 60 fps on the product's virtual display at 240 Hz, the stream's gate
(core/FrameCadence.h) encodes the first present of each 16.7 ms window. The
picture that carries a click usually comes later in its window and waits for
the next: 9.7 ms at the median on the bench of 13/10/2026
(docs/bench-native-host.md §8v.5). The rule proposed: for T after each press,
every present goes through, on top of the gate, whose grid keeps its phase
(gatesim.InputAdmit, a copy of core/InputAdmit.h). This replays it, and the
rules it was chosen against, on passes recorded with clicktrace=1:

  flag     the bench's flag (c60-um-A*): the `present` leg (flag painted → the
           present that carried it out), pictures more a click, at 60 and 120 fps
  target   mw-click-target, which reacts in 1 to 13 ms (*-aw2*-tear-*, *-clk-f60-*):
           its present → the first one admitted
  game     RE9, 62 to 77 pictures a second (*-re9-vis-*, *-re9-f60-*): presses at
           random moments, the game's picture 8, 16 or 24 ms after each
  display  a client that paints at its vsync, at 60, 120 and 144 Hz: what it
           shows around each click (long holds, double steps, steps off the
           stream's pattern)
  spam     presses faster than the bucket (clicks at 5/s, keys at 10/s, 30/s, a
           broken filter at 1 kHz): pictures a second more, and a click's wait
           when the bucket is empty
  encode   a slower encoder (the loop busy 3 to 8 ms an encode): what the
           window's pictures do to the grid's
  link     the host's link guard, on its model of a link at the stream's
           bitrate: what it refuses at 20 and 40 Mbit/s
  release  the releases taken as presses too

The method. The gate is called on every present of the trace, in the order the
loop woke up, at its wake-up (the host passes the conversion's moment, a
fraction of a millisecond later); a press reaches the window when its SendInput
began. Two corrections, both checked on the pictures the client received (each
frame's hostMs joined to a present, as POC Ultra's c60_presents.py did):
- the gate's phase is set on them. From the trace's first present, the replay
  of c60-um-A3 kept only 36 % of them: its grid had started on another present.
- a loop busy for more than 50 ms after a wake-up (c60-um-A3, 435 ms at its
  first click) went through the gate on its way back: a re-send, which the
  trace does not list, taken 2 ms before its next acquire began (the encode).
  Without it, the replay of c60-um-A3 kept 53 % of the pictures; with it, 96 %.

The rules (--variants, separated by spaces):
  base             the gate alone
  next             the first idea: the present after a press goes through at
                   once and counts for the next window
  T                a window of T ms (at least one interval of the stream), no bucket
  T,B,R[,S[,K]]    and a bucket of B windows ahead, R more a second (B 0: no
                   bucket); S the least gap in ms between two pictures
                   admitted; K the most pictures a window adds (0: as many
                   presents as the display makes in T)
  .../rephase      the grid restarts one interval after each picture of a window

    python inputsim.py [--sections flag,target,game,display,spam,encode,release]
                       [--variants "base next 16.7 16.7,3,2"] [--dir bench-out/content-age]
                       [--fps 60,120] [--rate 60]   (the flag's rates; the target's and game's)
"""
import argparse
import bisect
import csv
import glob
import json
import os
import random

import gatesim
import hostpath

OUT = os.path.join("bench-out", "content-age")
FLAG_TAGS = "c60-um-A[0-9]-*-client-r0"
TARGET_TAGS = ("u14att-um-smoke-hevc-*-dda-aw2?-tear-r?-v240-client-r0",
               "u14cad-um-smoke-hevc-sctp-dda-new-clk-f60-r?-v240-client-r0")
GAME_TAGS = ("u14att-um-smoke-hevc-rtp-dda-re9-vis-r?-v*-client-r0",
             "u14cad-um-smoke-hevc-sctp-dda-new-re9-f60-r?-v240-client-r0")
VARIANTS = "base next 16.7 25 16.7/rephase 16.7,3,2 33,3,2,0,3 33,3,2,8.3,3"
PROPOSAL = "33,3,2,0,3"
LATENCY_US = 5000  # wake-up → ready to show on the client, for the display model
# A delta's share of its interval at the stream's bitrate, for the link model:
# 38.4 KB at the median of the A passes, for 41.7 at 20 Mbit/s and 60 fps.
LINK_FILL = 0.92
NO_BUCKET = 10 ** 9


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else float("nan")


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


class Pass:
    def __init__(self, tag, d):
        self.tag = tag
        base = os.path.join(d, tag)
        rows = list(csv.DictReader(open(base + ".click-trace.csv")))
        # (wake-up, present), in the order the loop woke up.
        self.caps = sorted((int(r["us"]), int(r["presentUs"])) for r in rows
                           if r["kind"] == "capture" and r["status"] == "ok")
        # The loop busy for long after a wake-up: a re-send through the gate,
        # its encode ending as the next acquire began (see the module's doc).
        self.resends = sorted(int(b["startUs"]) - 2000 for a, b in zip(rows, rows[1:])
                              if b["startUs"] and int(b["startUs"]) - int(a["us"]) > 50000)
        self.present = sorted(p for _, p in self.caps)
        self.presses = sorted(int(r["startUs"]) for r in rows if r["kind"] == "press")
        # Since the window was written (plan « inputadmit »), the host's own
        # word: every press it noted, keys and pads too, and each present it
        # encoded, the gate's or the window's.
        noted = sorted(int(r["us"]) for r in rows if r["kind"] == "admit" and r["status"] == "press")
        if noted:
            self.presses = noted
        self.sent = {int(r["presentUs"]): r["status"] for r in rows
                     if r["kind"] == "admit" and r["presentUs"]}
        self.fps, self.hz = gatesim.pass_rates(base)
        self.scene = gatesim.scene(base)
        log = base + ".server.log"
        self.flags = hostpath.read_flags(log) if os.path.exists(log) else []
        self.target = []
        if os.path.exists(base + ".target.jsonl"):
            for line in open(base + ".target.jsonl", encoding="utf-8"):
                try:
                    j = json.loads(line)
                except ValueError:
                    continue
                if "click" in j and j.get("presentUs"):
                    self.target.append({"down": j["downUs"], "shown": j["presentUs"]})
        self.client_ms = []
        for suffix in (".frames.csv", ".clicks.frames.csv"):
            if os.path.exists(base + suffix):
                self.client_ms += [hostpath.num(r["hostMs"]) for r in csv.DictReader(open(base + suffix))
                                   if r.get("hostMs")]
        self.phase = {}

    def real_admitted(self):
        """The presents the host encoded at a present: its own rows when the
        trace has them (the gate's alone: the window's are not the gate's);
        else those the client received, each frame it logged joined to one."""
        if self.sent:
            return {p for p, how in self.sent.items() if how == "grid"}
        if not self.client_ms:
            return set()
        x = hostpath.stamp_offset(self.client_ms, self.present)
        out = set()
        for h in self.client_ms:
            lo = h * 1000 + x
            j = bisect.bisect_left(self.present, lo)
            if j < len(self.present) and self.present[j] < lo + 1000:
                out.add(self.present[j])
        return out


def parse_variant(text):
    """See the module's doc: base, next, T, T,B,R[,S], .../rephase."""
    v = {"name": text, "mode": text if text in ("base", "next") else "window",
         "rephase": text.endswith("/rephase")}
    if v["mode"] == "window":
        parts = [float(x) for x in text.split("/")[0].split(",")]
        v["T"] = parts[0] * 1000
        v["B"], v["R"] = (int(parts[1]), parts[2]) if len(parts) >= 3 and parts[1] else (NO_BUCKET, 0.0)
        v["S"] = parts[3] * 1000 if len(parts) >= 4 else 0
        v["K"] = int(parts[4]) if len(parts) >= 5 else 0
    return v


def replay(p, fps, hz, v, presses=None, phase_ns=None, busy_us=0, link_kbps=0):
    """The pictures the loop would encode, [(present, wake-up, kind)]: kind "g"
    for the grid's, "w" for the window's (or the first idea's). @p busy_us: the
    loop encodes for that long after each picture it admits; the presents that
    come meanwhile fold into the latest, taken when it is free (Desktop
    Duplication's AccumulatedFrames). @p link_kbps: the host's link guard, on
    its model of a link at that rate (LinkOccupancy), every picture LINK_FILL
    of the rate's share. With v["want_window"], also the InputAdmit, for its
    counts."""
    gate = gatesim.Gate(fps, hz)
    if phase_ns is not None:
        gate.next_due_ns = phase_ns
    presses = p.presses if presses is None else presses
    win = None
    if v["mode"] == "window" and not gate.ceiling:
        win = gatesim.InputAdmit(v["T"], v["B"], v["R"], v["S"], gate.interval_ns // 1000, hz, v["K"])
    out, pi, ri, pending, free, busy = [], 0, 0, False, 0, 0
    link_us = int(1e6 / fps * LINK_FILL) if link_kbps else 0
    bound_us = ((win.max_extra if win else 3) + 1) * (gate.interval_ns // 1000)
    caps, i, n = p.caps, 0, len(p.caps)
    while i < n:
        u, present = caps[i]
        if busy_us and u < free:
            j = i
            while j + 1 < n and caps[j + 1][0] <= free:
                j += 1
            u, present, i = free, caps[j][1], j
        while ri < len(p.resends) and p.resends[ri] <= u:
            gate.admit(p.resends[ri])
            ri += 1
        while pi < len(presses) and presses[pi] <= u:
            if win:
                win.note_press(presses[pi])
            elif v["mode"] == "next":
                pending = True
            pi += 1
        kind = None
        if v["mode"] == "next" and pending and present > presses[pi - 1]:
            # The first idea: this present goes now and counts for the next window.
            pending = False
            gate.next_due_ns += gate.interval_ns
            kind = "w"
        else:
            grid = gate.admit(u)
            kind = "g" if grid else None
            link_ok = not link_kbps or busy - u <= bound_us
            if win and win.admit(grid, present, u, link_ok=link_ok) and not grid:
                kind = "w"
                if v["rephase"]:
                    gate.next_due_ns = u * 1000 + gate.interval_ns
        if kind:
            out.append((present, u, kind))
            if busy_us:
                free = u + busy_us
            if link_kbps:
                busy = max(busy, u) + link_us
        i += 1
    return (out, win) if v.get("want_window") else out


def align(p, fps, hz):
    """The gate's first due time (ns) whose replay keeps most of the pictures
    the client received, and that share; (None, None) without client frames."""
    key = (fps, hz)
    if key in p.phase:
        return p.phase[key]
    real = p.real_admitted()
    if not real or fps != p.fps or hz != p.hz:
        p.phase[key] = (None, None)
        return p.phase[key]
    lo, hi = min(real), max(real)
    interval_us = 1000000 // fps
    base = parse_variant("base")
    t0 = p.caps[0][0]
    best = (-1, None)
    for k in range(0, interval_us, 125):
        got = replay(p, fps, hz, base, presses=[], phase_ns=(t0 + k) * 1000)
        hit = sum(1 for pr, _, _ in got if lo <= pr <= hi and pr in real)
        best = max(best, (hit, (t0 + k) * 1000))
    got = replay(p, fps, hz, base, presses=[], phase_ns=best[1])
    inside = [pr for pr, _, _ in got if lo <= pr <= hi]
    p.phase[key] = (best[1], (best[0] / len(real), len(inside) / len(real)))
    return p.phase[key]


def carried_by(adm_presents, adm_kinds, shown, present):
    """For a change shown at @p shown: the first present after it, and the
    first admitted at or after that one (and its kind)."""
    j0 = bisect.bisect_right(present, shown)
    if j0 >= len(present):
        return None
    k = bisect.bisect_left(adm_presents, present[j0])
    if k >= len(adm_presents):
        return None
    return present[j0], adm_presents[k], adm_kinds[k]


def legs(p, adm, moments):
    """Per moment a change was shown: (shown → admitted present, admitted
    present − the first present after it, kind)."""
    ap = [a[0] for a in adm]
    ak = [a[2] for a in adm]
    out = []
    for s in moments:
        c = carried_by(ap, ak, s, p.present)
        if c:
            out.append(((c[1] - s) / 1000, (c[1] - c[0]) / 1000, c[2]))
    return out


def span_s(p):
    return (p.caps[-1][0] - p.caps[0][0]) / 1e6


def load(d, patterns):
    tags = []
    for pat in patterns:
        tags += sorted(os.path.basename(f)[:-len(".click-trace.csv")]
                       for f in glob.glob(os.path.join(d, pat + ".click-trace.csv")))
    return [Pass(t, d) for t in tags]


# ── flag ─────────────────────────────────────────────────────────────────────

def section_flag(passes, variants, fps_list):
    print("== flag: the bench's flag (c60-um-A*), click -> the present that carried it")
    for p in passes:
        ph, share = align(p, p.fps, p.hz)
        if ph is not None:
            print("  %s: the replay keeps %.1f %% of the pictures the client got (%.1f %% as many)" % (
                p.tag, 100 * share[0], 100 * share[1]))
    for fps in fps_list:
        print("  stream %d fps, display %d Hz; `present` = flag painted -> the present carried "
              "(hostpath's leg), its p50/p90/mean; `wait` = the first present after the flag -> "
              "that one" % (fps, passes[0].hz))
        print("  %-22s %7s %7s %7s %7s %10s %9s %8s" % (
            "rule", "p50", "p90", "mean", "wait50", "more/click", "pict/s", "window%"))
        base_n = None
        for v in variants:
            ls, more, frames, span, clicks = [], 0, 0, 0.0, 0
            for p in passes:
                ph = align(p, fps, p.hz)[0]
                adm = replay(p, fps, p.hz, v, phase_ns=ph)
                ref = replay(p, fps, p.hz, parse_variant("base"), presses=[], phase_ns=ph)
                more += len(adm) - len(ref)
                frames += len(adm)
                span += span_s(p)
                clicks += len(p.presses)
                ls += legs(p, adm, [f["shown"] for f in p.flags])
            print("  %-22s %7.2f %7.2f %7.2f %7.2f %10.2f %9.2f %8.0f" % (
                v["name"], q([x[0] for x in ls], .5), q([x[0] for x in ls], .9), mean([x[0] for x in ls]),
                q([x[1] for x in ls], .5), more / clicks, frames / span,
                100 * sum(1 for x in ls if x[2] == "w") / len(ls)))
    print()


# ── target ───────────────────────────────────────────────────────────────────

def section_target(passes, variants, fps):
    print("== target: mw-click-target (its own present of the click -> the first present admitted "
          "at or after the first present after it), stream %d fps" % fps)
    print("  %-62s %5s %5s | %s" % ("pass", "react", "", "  ".join("%-16s" % v["name"] for v in variants)))
    pooled = {v["name"]: ([], 0, 0) for v in variants}
    for p in passes:
        reacts = [(c["shown"] - c["down"]) / 1000 for c in p.target]
        row = "  %-62s %5.1f %5s |" % (p.tag[:62], q(reacts, .5), "")
        for v in variants:
            adm = replay(p, fps, p.hz, v)
            ref = replay(p, fps, p.hz, parse_variant("base"), presses=[])
            ls = legs(p, adm, [c["shown"] for c in p.target])
            more = (len(adm) - len(ref)) / max(1, len(p.presses))
            w, m, n = pooled[v["name"]]
            pooled[v["name"]] = (w + [x[1] for x in ls], m + len(adm) - len(ref), n + len(p.presses))
            row += " %4.1f/%4.1f +%4.2f " % (q([x[1] for x in ls], .5), q([x[1] for x in ls], .9), more)
        print(row)
    row = "  %-62s %5s %5s |" % ("pooled: wait p50/p90 ms, pictures more a click", "", "")
    for v in variants:
        w, m, n = pooled[v["name"]]
        row += " %4.1f/%4.1f +%4.2f " % (q(w, .5), q(w, .9), m / max(1, n))
    print(row)
    print()


# ── game ─────────────────────────────────────────────────────────────────────

def section_game(passes, variants, fps, reactions=(8000, 16000, 24000)):
    print("== game: RE9, a press a second at a random moment, the game's picture of it r ms "
          "later; stream %d fps (wait p50/p90 ms, pictures more a press)" % fps)
    rng = random.Random(13)
    for p in passes:
        lo, hi = p.scene or (p.caps[0][0], p.caps[-1][0])
        lo, hi = lo + 1000000, hi - 1000000
        presses = [int(lo + i * 1e6 + rng.random() * 1e6) for i in range(int((hi - lo) / 1e6) - 1)]
        inside = [c for c in p.caps if lo <= c[0] <= hi]
        rate = len(inside) / ((hi - lo) / 1e6)
        print("  %s: %.1f pictures a second in the scene, %d presses" % (p.tag, rate, len(presses)))
        ref = replay(p, fps, p.hz, parse_variant("base"), presses=[])
        for r in reactions:
            row = "    r=%2d ms:" % (r / 1000)
            for v in variants:
                adm = replay(p, fps, p.hz, v, presses=presses)
                ls = legs(p, adm, [t + r for t in presses])
                more = (len(adm) - len(ref)) / len(presses)
                row += "  %s %4.1f/%4.1f +%.2f" % (v["name"], q([x[1] for x in ls], .5),
                                                   q([x[1] for x in ls], .9), more)
            print(row)
    print()


# ── display ──────────────────────────────────────────────────────────────────

def shown_at_vsync(adm, t0, t1, hz, phase_us, latency_us=LATENCY_US):
    """The content (present) on the screen of a client at @p hz that shows the
    latest picture ready at each of its refreshes."""
    per = 1e6 / hz
    ready = [a[1] + latency_us for a in adm]
    out, t = [], t0 + phase_us
    while t < t1:
        k = bisect.bisect_right(ready, t) - 1
        if k >= 0:
            out.append(adm[k][0])
        t += per
    return out


def display_counts(adm, presses, hz, fps, before_us=40000, after_us=60000, phases=8):
    """Around each press, over @p phases phases of the client's vsync: the share
    of clicks with a picture held longer than the stream's pattern allows (a
    repeat at 60 Hz), with a double step (content ≥ 1.75 intervals in one
    refresh), and the steps off the stream's pattern (more than 3 ms from a
    whole number of intervals) a click."""
    interval = 1e6 / fps
    longest = -(-hz // fps)  # refreshes a picture of the stream may stay up
    held = double = off = tot = 0
    for ph in range(phases):
        for t in presses:
            shown = shown_at_vsync(adm, t - before_us, t + after_us, hz, ph * (1e6 / hz) / phases)
            steps = [b - a for a, b in zip(shown, shown[1:])]
            tot += 1
            run, worst = 1, 1
            for s in steps:
                run = run + 1 if s == 0 else 1
                worst = max(worst, run)
            held += worst > longest
            double += any(s >= 1.75 * interval for s in steps)
            off += sum(1 for s in steps if s and abs(s - round(s / interval) * interval) > 3000)
    return 100 * held / tot, 100 * double / tot, off / tot


def section_display(passes, variants, fps, rates=(60, 120, 144)):
    print("== display: a client that paints at its vsync, the latest picture ready %.0f ms after "
          "the wake-up; %d fps stream; around each click (40 ms before, 60 after), 8 phases" % (
              LATENCY_US / 1000, fps))
    print("   held: %% of clicks with a picture up longer than the pattern (a repeat at 60 Hz); "
          "double: %% with a step of 1.75 intervals or more; off: steps off the pattern a click")
    for hz in rates:
        row = "  %3d Hz:" % hz
        for v in variants:
            h = d = o = 0.0
            for p in passes:
                ph = align(p, fps, p.hz)[0]
                adm = replay(p, fps, p.hz, v, phase_ns=ph)
                a, b, c = display_counts(adm, p.presses, hz, fps)
                h, d, o = h + a / len(passes), d + b / len(passes), o + c / len(passes)
            row += "  %s held %4.1f double %4.1f off %4.2f |" % (v["name"], h, d, o)
        print(row)
    print()


# ── spam ─────────────────────────────────────────────────────────────────────

def outcome_of(win, t):
    """What the window made of the press at @p t: "open", "carried" or "refused"."""
    for first, last, what in win.outcomes:
        if first <= t <= last:
            return what
    return None


def section_spam(p, variants, fps, react_us=10000):
    print("== spam: synthetic presses over %s's click phase, its presents, stream %d fps: pictures "
          "a second more" % (p.tag, fps))
    # The click phase: the presents come without a pause there.
    t0, t1 = p.presses[0], p.presses[-1]
    span = (t1 - t0) / 1e6
    ref = [a for a in replay(p, fps, p.hz, parse_variant("base"), presses=[]) if t0 <= a[1] < t1]
    patterns = (("clicks 1/s", 1e6), ("clicks 5/s", 2e5), ("keys 10/s", 1e5), ("presses 30/s", 33333),
                ("1 kHz", 1000))
    rng = random.Random(13)

    def at(step):
        # Each press at a random moment of its step (at most an interval of the
        # stream): a whole number of intervals apart, they would all fall at
        # one phase of the grid.
        return [int(t0 + i * step + rng.random() * min(step, 1e6 / fps))
                for i in range(int((t1 - t0) / step))]

    print("  %-14s %s" % ("", "  ".join("%14s" % v["name"] for v in variants)))
    for name, step in patterns:
        presses = at(step)
        row = "  %-14s" % name
        for v in variants:
            adm = [a for a in replay(p, fps, p.hz, v, presses=presses) if t0 <= a[1] < t1]
            row += "  %+14.1f" % ((len(adm) - len(ref)) / span)
        print(row)
    print("  a click's wait (its picture %d ms after it; first present after -> first admitted, "
          "p50/p90 ms) while the presses come:" % (react_us / 1000))
    for name, step in (("clicks 5/s", 2e5), ("keys 10/s", 1e5)):
        presses = at(step)
        ls_base = legs(p, ref, [t + react_us for t in presses])
        row = "  %-11s base %4.1f/%4.1f" % (name, q([x[1] for x in ls_base], .5), q([x[1] for x in ls_base], .9))
        for v in variants:
            if v["mode"] != "window":
                continue
            v2 = dict(v, want_window=True)
            adm, win = replay(p, fps, p.hz, v2, presses=presses)
            ls = legs(p, adm, [t + react_us for t in presses])
            outcomes = [outcome_of(win, t) for t in presses]
            served = [x[1] for x, o in zip(ls, outcomes) if o != "refused"]
            refused = [x[1] for x, o in zip(ls, outcomes) if o == "refused"]
            # The same presses under the gate alone: a refused press must wait no longer.
            alone = [x[1] for x, o in zip(ls_base, outcomes) if o == "refused"]
            row += " | %s: served %d %4.1f/%4.1f, refused %d %4.1f/%4.1f (gate alone %4.1f/%4.1f)" % (
                v["name"], len(served), q(served, .5), q(served, .9), len(refused), q(refused, .5),
                q(refused, .9), q(alone, .5), q(alone, .9))
        print(row)
    print()


# ── encode ───────────────────────────────────────────────────────────────────

def section_encode(passes, v, fps, busy_list=(0, 2500, 3000, 4200, 5000, 6000, 8000)):
    print("== encode: the loop busy E ms after each picture it admits (NVENC on the A passes: "
          "1.7 mean, 2.3 p95, already in the trace), stream %d fps, rule %s" % (fps, v["name"]))
    print("  grid late: the grid's pictures, wake-up - present, p50/p99 ms; grid/s: the grid's "
          "pictures a second; the guard turns the window off when the encode's p95 is over a "
          "refresh of the display (%.1f ms)" % (1e3 / passes[0].hz))
    print("  %6s | %-28s | %-46s" % ("E ms", "base: grid/s  late p50/p99", "window: grid/s late p50/p99"
                                     "  present p50/p90  more/click"))
    for busy in busy_list:
        res = {}
        for name, var in (("base", parse_variant("base")), ("win", v)):
            g_late, g_n, span, ls, more, clicks = [], 0, 0.0, [], 0, 0
            for p in passes:
                ph = align(p, fps, p.hz)[0]
                adm = replay(p, fps, p.hz, var, phase_ns=ph, busy_us=busy)
                ref = replay(p, fps, p.hz, parse_variant("base"), presses=[], phase_ns=ph, busy_us=busy)
                g = [a for a in adm if a[2] == "g"]
                g_late += [(a[1] - a[0]) / 1000 for a in g]
                g_n += len(g)
                span += span_s(p)
                ls += legs(p, adm, [f["shown"] for f in p.flags])
                more += len(adm) - len(ref)
                clicks += len(p.presses)
            res[name] = (g_n / span, q(g_late, .5), q(g_late, .99), q([x[0] for x in ls], .5),
                         q([x[0] for x in ls], .9), more / clicks)
        b, w = res["base"], res["win"]
        print("  %6.1f | %6.2f  %5.2f / %5.2f       | %6.2f %5.2f / %5.2f   %5.2f / %5.2f   %+5.2f" % (
            busy / 1000, b[0], b[1], b[2], w[0], w[1], w[2], w[3], w[4], w[5]))
    print()


# ── link ─────────────────────────────────────────────────────────────────────

def section_link(passes, v, fps, rates=(20000, 40000)):
    print("== link: the host's guard on its model of a link at the stream's bitrate (each picture "
          "%.0f %% of its interval's share), rule %s, stream %d fps: window pictures, and those the "
          "model refused" % (100 * LINK_FILL, v["name"], fps))
    rng = random.Random(7)
    for name, step in (("the bench's clicks", None), ("clicks 2/s", 5e5), ("clicks 5/s", 2e5)):
        row = "  %-20s" % name
        for kbps in rates:
            pics = refused = 0
            for p in passes:
                presses = p.presses if step is None else [
                    int(p.presses[0] + i * step + rng.random() * 1e6 / fps)
                    for i in range(int((p.presses[-1] - p.presses[0]) / step))]
                adm, win = replay(p, fps, p.hz, dict(v, want_window=True), presses=presses,
                                  phase_ns=align(p, fps, p.hz)[0], link_kbps=kbps)
                pics += win.frames
                refused += win.link_refused
            row += "  %d kbps: %4d pictures, %4d refused |" % (kbps, pics, refused)
        print(row)
    print()


# ── release ──────────────────────────────────────────────────────────────────

def section_release(passes, v, fps):
    print("== release: the releases as presses too, rule %s, stream %d fps" % (v["name"], fps))
    for hold_ms in (None, 0.1, 100):
        ls, more, clicks, outcomes = [], 0, 0, {}
        for p in passes:
            ph = align(p, fps, p.hz)[0]
            presses = p.presses if hold_ms is None else sorted(
                p.presses + [t + int(hold_ms * 1000) for t in p.presses])
            adm, win = replay(p, fps, p.hz, dict(v, want_window=True), presses=presses, phase_ns=ph)
            ref = replay(p, fps, p.hz, parse_variant("base"), presses=[], phase_ns=ph)
            ls += legs(p, adm, [f["shown"] for f in p.flags])
            more += len(adm) - len(ref)
            clicks += len(p.presses)
            for _, _, o in win.outcomes:
                outcomes[o] = outcomes.get(o, 0) + 1
        what = "presses only" if hold_ms is None else "release %g ms after" % hold_ms
        print("  %-24s present p50/p90 %5.2f / %5.2f ms, %+.2f pictures a click; presses taken: %s" % (
            what, q([x[0] for x in ls], .5), q([x[0] for x in ls], .9), more / clicks,
            ", ".join("%s %d" % kv for kv in sorted(outcomes.items()))))
    print()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", default=OUT)
    ap.add_argument("--sections", default="flag,target,game,display,spam,encode,link,release")
    ap.add_argument("--variants", help="the rules every section compares (default: each its own)")
    ap.add_argument("--proposal", default=PROPOSAL, help="the rule the encode and release sections try")
    ap.add_argument("--fps", default="60,120", help="the stream's rates for the flag section")
    ap.add_argument("--rate", type=int, default=60,
                    help="the stream's rate for the target and game sections")
    a = ap.parse_args()
    sections = a.sections.split(",")

    def rules(default):
        return [parse_variant(t) for t in (a.variants or default).split()]

    proposal = parse_variant(a.proposal)
    flag = load(a.dir, [FLAG_TAGS]) if set(sections) & {"flag", "display", "spam", "encode", "link",
                                                     "release"} else []
    if "flag" in sections:
        section_flag(flag, rules(VARIANTS), [int(f) for f in a.fps.split(",")])
    if "target" in sections:
        section_target(load(a.dir, TARGET_TAGS), rules("base 16.7 33,3,2,0,3 33,3,2,0,2"), a.rate)
    if "game" in sections:
        section_game(load(a.dir, GAME_TAGS), rules("base 16.7 25 33,3,2,0,3"), a.rate)
    if "display" in sections:
        section_display(flag, rules("base 16.7 33,3,2,0,3 33,3,2,0,2 25,3,2,8.3 33,3,2,8.3,3"), 60)
    if "spam" in sections:
        section_spam(flag[0], rules("16.7 33,3,2,0,3 33,4,6,0,3 33,2,1,0,3"), 60)
    if "encode" in sections:
        section_encode(flag, proposal, 60)
    if "link" in sections:
        section_link(flag, proposal, 60)
    if "release" in sections:
        section_release(flag, proposal, 60)


if __name__ == "__main__":
    main()
