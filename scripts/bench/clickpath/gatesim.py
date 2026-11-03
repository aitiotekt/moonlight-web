"""The stream's gate replayed on a pass's captures (plan « attente », 09/10/2026).

The native host encodes only the presents its gate admits
(backend/native-host/src/core/FrameCadence.h): the first present in each
tick's window of the stream's grid, from a quarter of an interval before the
tick to a quarter before the next. A window with nothing in it moves the grid
to the present that ends the gap; two, and the grid restarts on it.
This replays that gate, offline, on the captures a pass recorded, at any
stream rate and display rate, and says what the stream would have carried.

⚠️ Gate below is a COPY of FrameCadence::admit() (and of ceiling(), for a
stream at or above the display's rate): the nanosecond grid, kSlackDivisor 4,
kCeilingHeadroom 50, the windows, a ceiling's re-anchor past one display
period. Change it with the class. --before is the gate of the passes of 08-09/10
(re-anchored on any present later than one display period); checked on
09/10/2026, on every pass of benches 2 and c1 it gives the host's own "N not
carried" count to within 2 (7731 for 7733).

What it needs: a pass run with clicktrace=1 in MW_NATIVE_TUNING, whose capture
wake-ups were copied as bench-out/content-age/<tag>.click-trace.csv (see the
README). Traces of 08-09/10/2026 there:
  *-re9-vis-*      RE9 alone, ~77 pictures a second, virtual display at 120
                   and 240 Hz (<tag>.re9.txt bounds the game's scene)
  *-aw21-*         mw-click-target at 240 fps, virtual display at 120 / 240 Hz
  *-aw2c-*, *-aw2s-*  the same at 240 Hz, the stream at 120 or 240 fps

    python gatesim.py <tag> [<tag>...] [--fps 60] [--hz 240] [--before | --advance]

--fps / --hz: the stream's rate and the display's (default: both from the
pass's log). --before: the gate until the fix of 09/10/2026 (Cadence session),
for a pass recorded with it. --advance: the change the Android TV bench
proposed (B, 08/10/2026), a present later than one display period moving the
grid on by whole intervals from the tick it missed; it gives the rate back but
lets a game at the stream's rate beat against the grid. Per pass: the new pictures,
those the gate skipped, how long a skipped picture's change waited for the
next admitted one, and that wait averaged over every instant (what a click at
a random moment pays for the gate).

--inputadmit T[,B,R,S,K] (plan « inputadmit », 13/10/2026): the admission
window after a press on top of the gate, replayed on the pass's own presses
(the trace's `press` rows). T in ms, B windows ahead, R windows a second, S the
least gap in ms between two admitted pictures, K the most pictures a window
adds (0: as many presents as the display makes in T); B, R, S and K default to
3, 2, 0 and 3, the host's own defaults.
Its class, InputAdmit, is a COPY of core/InputAdmit.h, like Gate's. The
variants and what they cost the client: inputsim.py.

--lock (plan « glissade », 14/10/2026): the gate locked on the display's
presents. A Lattice (a COPY of core/PresentLattice.h) follows the presents'
own times; while it is engaged and the stream's interval is N >= 2 display
periods, the gate decides on each present's own time and keeps the start of
its windows halfway between two presents of the lattice. The lattice's period
is the host's, from its end-of-session line "cadence lock: period <ns> ns,
interval <ns> ns", else --period-ns, else 1e9 / the display's rate. A pointer
alone goes through the gate too when the pass drew the pointer into the
picture (--pointers). The table per family of passes, today against the lock:
locksim.py.

--interval-ns: the exact interval of a cadence aligned on a client that paints
on its vsync (CadenceAlign.h), which the log says only in that same line.

--selftest: the golden train, a synthetic pass of known presents run through
the locked gate, whose counts the C++ tests (test_cadence_lock.cpp) hold too.
"""
import argparse
import csv
import os
import re

OUT = os.path.join("bench-out", "content-age")


class Lattice:
    """core/PresentLattice.h: the display's presents, as a lattice of period
    T whose phase follows them, for the gate to lock its windows on.

    ⚠️ A COPY of PresentLattice, as Gate is of FrameCadence: change both
    together. Whole nanoseconds; every division rounds down (floor), in C++
    as here (C++ needs floorDiv for it, Python's // is one).
    - Fed the time of each real present, skipped by the gate or not, before
      the gate decides; never a pointer alone, an empty wait nor a re-send.
    - The phase loop: e, a present's offset from the lattice's nearest point;
      the phase follows e/32, e bounded to ±T/4. A present at or before the
      last one taken, or on the same point, leaves no trace.
    - The sharpness: the mean of |e|, plain over the first 64 presents, then
      running (gain 1/64). Engaged under T/10 once 64 presents are in, let go
      above T/5.
    - The phase starts again on the present after a pause of more than 10 s,
      or of more than 1 s that left it beyond T/4: a resync, not counted in
      the sharpness.
    """

    GAIN = 32
    SAMPLES = 64
    PAUSE_NS = 10 * 1000000000
    SHORT_PAUSE_NS = 1000000000

    NONE, ENGAGED, RELEASED, RESYNCED = "none", "engaged", "released", "resynced"

    def __init__(self, period_ns):
        self.period_ns = int(period_ns)
        self.started = False
        self.phase_ns = 0
        self.last_ns = 0
        self.first_ns = 0
        self.samples = 0
        # Sum of |e| over the first SAMPLES presents, then SAMPLES times the
        # running mean.
        self.acc = 0
        self.engaged = False
        self.taken = self.ignored = 0
        self.engagements = self.releases = self.resyncs = 0
        self.first_engaged_ns = None

    def note(self, present_ns):
        """One present's time; what it changed: NONE, ENGAGED, RELEASED or RESYNCED."""
        t = self.period_ns
        if not self.started:
            self.started = True
            self.phase_ns = self.last_ns = self.first_ns = present_ns
            self.taken += 1
            return self.NONE
        if present_ns <= self.last_ns:
            self.ignored += 1
            return self.NONE
        k = (present_ns - self.phase_ns + t // 2) // t
        if k <= 0:
            self.ignored += 1
            return self.NONE
        predicted = self.phase_ns + k * t
        e = present_ns - predicted
        gap = present_ns - self.last_ns
        self.taken += 1
        if gap > self.PAUSE_NS or (gap > self.SHORT_PAUSE_NS and 4 * abs(e) > t):
            self.phase_ns = self.last_ns = present_ns
            self.resyncs += 1
            return self.RESYNCED
        bound = t // 4
        self.phase_ns = predicted + max(-bound, min(bound, e)) // self.GAIN
        self.last_ns = present_ns
        if self.samples < self.SAMPLES:
            self.acc += abs(e)
            self.samples += 1
            if self.samples < self.SAMPLES:
                return self.NONE
        else:
            self.acc += abs(e) - self.acc // self.SAMPLES
        if not self.engaged and 10 * self.acc < self.SAMPLES * t:
            self.engaged = True
            self.engagements += 1
            if self.first_engaged_ns is None:
                self.first_engaged_ns = present_ns
            return self.ENGAGED
        if self.engaged and 5 * self.acc > self.SAMPLES * t:
            self.engaged = False
            self.releases += 1
            return self.RELEASED
        return self.NONE

    def slot_ns(self, t_ns):
        """The lattice's point nearest @p t_ns (a tie goes to the later one)."""
        t = self.period_ns
        return self.phase_ns + (t_ns - self.phase_ns + t // 2) // t * t

    def mid_ns(self, x_ns):
        """The halfway point between two of the lattice's points nearest @p x_ns."""
        t = self.period_ns
        first = self.phase_ns + t // 2
        return first + (x_ns - first + t // 2) // t * t

    def sharpness(self):
        """The mean |e| in periods: 0.25 for presents at random."""
        n = min(self.samples, self.SAMPLES)
        return self.acc / n / self.period_ns if n else float("nan")


def period_ns_from_millihz(millihz):
    """PresentLattice::periodNsFromMilliHz: 4166666 for 240000."""
    return 10 ** 12 // millihz if millihz > 0 else 0


def period_ns_from_rational(numerator, denominator):
    """PresentLattice::periodNsFromRational, for a DXGI mode's RefreshRate."""
    return 10 ** 9 * denominator // numerator if numerator > 0 and denominator > 0 else 0


class Gate:
    """FrameCadence::admit(); rule "before" or "advance" for the older ones.

    With a Lattice (plan « glissade »), the gate locked on it: see
    _admit_locked(). Without one it is today's, exactly."""

    SLACK_DIVISOR = 4
    CEILING_HEADROOM = 50
    # FrameCadence::lockRatio(): an interval within 1/500 of N periods.
    LOCK_TOLERANCE = 500

    def __init__(self, fps, display_hz, rule="now", interval_ns=None):
        self.interval_ns = (1000000 // fps) * 1000
        self.ceiling = fps >= display_hz
        if self.ceiling:
            self.interval_ns = self.interval_ns * self.CEILING_HEADROOM // (self.CEILING_HEADROOM + 1)
        if interval_ns:
            # The interval as the host's gate held it (its end-of-session line):
            # a cadence aligned on a client that paints on its vsync, an exact
            # multiple of its measured period (FrameCadence::fromIntervalNs),
            # or a ceiling's, already shortened.
            self.interval_ns = int(interval_ns)
        self.reanchor_ns = (1000000 // display_hz) * 1000
        interval_us = self.interval_ns // 1000
        self.slack_us = interval_us if self.ceiling else interval_us // self.SLACK_DIVISOR
        self.next_due_ns = 0
        self.rule = rule
        self.skipped = 0
        # The rule of each admission: "today" (the gate unlocked), or locked:
        # "window" (in its window), "empty" (after a window with nothing in
        # it), "pause" (later still).
        self.rules = {"today": 0, "window": 0, "empty": 0, "pause": 0}
        self.locked_calls = self.calls = 0

    def lock_ratio(self, period_ns):
        """FrameCadence::lockRatio(): N when the interval is N >= 2 display
        periods to within 0.2 %, else 0 (and 0 for a ceiling)."""
        if self.ceiling or self.interval_ns <= 0 or period_ns <= 0:
            return 0
        n = (self.interval_ns + period_ns // 2) // period_ns
        if n < 2 or self.LOCK_TOLERANCE * abs(self.interval_ns - n * period_ns) > n * period_ns:
            return 0
        return n

    def admit(self, now_us, present_us=None, lattice=None):
        """@p now_us the time the gate decides on today (the end of the
        conversion); @p present_us the picture's own (a present's, a pointer's
        wake-up, a re-send's now), and @p lattice, both for the locked gate."""
        self.calls += 1
        if lattice is not None and lattice.engaged and self.rule == "now":
            n = self.lock_ratio(lattice.period_ns)
            if n:
                self.locked_calls += 1
                return self._admit_locked(present_us, lattice, n)
        return self._admit_today(now_us)

    def _admit_locked(self, present_us, lattice, n):
        """The gate locked on @p lattice: one time scale, the pictures' own;
        an interval of exactly @p n periods; each window starting halfway
        between two presents of the lattice.
        - In its window: the next opens at the halfway point nearest one
          interval on, where the lattice's loop corrects it, never before
          the one that follows this picture.
        - After a window with nothing in it: half a period after this
          picture's place on the lattice.
        - Later (a pause): one interval less half a period after it, so that
          content that comes back dense is carried an interval apart.
        nextDueUs() keeps its meaning: the window's start plus today's slack."""
        t = lattice.period_ns
        now_ns = present_us * 1000
        slack_ns = self.slack_us * 1000
        start_ns = self.next_due_ns - slack_ns
        if now_ns < start_ns:
            self.skipped += 1
            return False
        interval_ns = n * t
        if now_ns < start_ns + interval_ns:
            nxt = lattice.mid_ns(start_ns + interval_ns)
            least = lattice.slot_ns(now_ns) + t // 2
            if nxt < least:
                nxt = least
            self.rules["window"] += 1
        elif now_ns < start_ns + 2 * interval_ns:
            nxt = lattice.slot_ns(now_ns) + t // 2
            self.rules["empty"] += 1
        else:
            nxt = lattice.slot_ns(now_ns) + interval_ns - t // 2
            self.rules["pause"] += 1
        self.next_due_ns = nxt + slack_ns
        return True

    def _admit_today(self, now_us):
        now_ns = now_us * 1000
        slack_ns = self.slack_us * 1000
        if now_ns + slack_ns < self.next_due_ns:
            self.skipped += 1
            return False
        self.rules["today"] += 1
        late_ns = now_ns - self.next_due_ns
        if self.ceiling or self.rule != "now":
            if late_ns <= self.reanchor_ns:
                self.next_due_ns += self.interval_ns
            elif self.rule == "advance" and not self.ceiling and self.next_due_ns:
                self.next_due_ns += (late_ns // self.interval_ns + 1) * self.interval_ns
            else:
                self.next_due_ns = now_ns + self.interval_ns
            return True
        window_end_ns = self.interval_ns - slack_ns
        if late_ns < window_end_ns:
            self.next_due_ns += self.interval_ns
        elif late_ns < window_end_ns + self.interval_ns:
            self.next_due_ns = now_ns + slack_ns
        else:
            self.next_due_ns = now_ns + self.interval_ns
        return True


class InputAdmit:
    """core/InputAdmit.h: for T after a press, every present goes through, on
    top of the gate, whose grid keeps its phase (it is asked first, on every
    present, and never learns of these pictures).

    ⚠️ A COPY of InputAdmit, as Gate is of FrameCadence: change both together.
    - A window opens on a press for one token of a bucket of windows (B ahead,
      R more a second): a window opens whole or not at all. A press inside an
      open window carries it on to T after itself, for no token.
    - It admits the presents made from the press to T after it (their present,
      not their wake-up: a picture composed before the press cannot carry it),
      at most `max_extra` beyond the grid's, each S at least after the last
      picture admitted, grid or window.
    - Presses between two of the loop's calls are taken together: the window
      from the first to T after the last. Presses the loop takes only once
      their window is over open nothing.
    - The caller's guards: the link's word, and the encoder's.
    """

    def __init__(self, window_us, burst=3, rate=2.0, gap_us=0, interval_us=16666, display_hz=240,
                 max_extra=0):
        # At least one interval of the stream: a shorter window can end
        # before the grid's next picture would have come anyway.
        self.window_us = max(int(window_us), int(interval_us))
        self.burst = burst
        self.rate = rate
        self.gap_us = int(gap_us)
        # By default the presents a window can hold at the display's rate: a
        # source that presents faster than its display refreshes gets no more.
        self.max_extra = max_extra or max(1, round(self.window_us * display_hz / 1e6))
        self.tokens = float(burst)
        self.refilled_us = None
        self.first_us = self.last_press_us = None
        self.start_us = self.end_us = None
        self.extra = 0
        self.last_us = None
        self.presses = self.windows = self.carried = self.refused = self.late = 0
        self.frames = self.capped = self.gapped = self.link_refused = self.encoder_refused = 0
        # Each group of presses taken: (first, last, "open" | "carried" | "refused"),
        # for inputsim.py.
        self.outcomes = []

    def note_press(self, now_us):
        """The input thread: a press, kept until the loop takes it."""
        self.presses += 1
        if self.first_us is None:
            self.first_us = now_us
        self.last_press_us = now_us

    def _take_press(self, now_us):
        first_us, last_us = self.first_us, self.last_press_us
        self.first_us = self.last_press_us = None
        if last_us + self.window_us <= now_us:
            self.late += 1
            self.outcomes.append((first_us, last_us, "late"))
            return
        if self.refilled_us is not None:
            self.tokens = min(self.burst, self.tokens + (first_us - self.refilled_us) * self.rate / 1e6)
        self.refilled_us = first_us
        if self.end_us is not None and first_us < self.end_us:
            self.end_us = last_us + self.window_us
            self.carried += 1
            self.outcomes.append((first_us, last_us, "carried"))
        elif self.tokens >= 1:
            self.tokens -= 1
            self.start_us, self.end_us, self.extra = first_us, last_us + self.window_us, 0
            self.windows += 1
            self.outcomes.append((first_us, last_us, "open"))
        else:
            self.refused += 1
            self.outcomes.append((first_us, last_us, "refused"))

    def admit(self, grid_said, present_us, now_us, link_ok=True, encoder_ok=True):
        """@p grid_said: the gate's answer for this present. True: encode it."""
        if self.first_us is not None:
            self._take_press(now_us)
        if grid_said:
            self.last_us = now_us
            return True
        if self.end_us is None or not self.start_us <= present_us < self.end_us:
            return False
        if self.extra >= self.max_extra:
            self.capped += 1
            return False
        if self.gap_us and self.last_us is not None and now_us - self.last_us < self.gap_us:
            self.gapped += 1
            return False
        if not encoder_ok:
            self.encoder_refused += 1
            return False
        if not link_ok:
            self.link_refused += 1
            return False
        self.extra += 1
        self.frames += 1
        self.last_us = now_us
        return True


def parse_inputadmit(text):
    """'T[,B,R,S,K]' (ms, windows, windows a second, ms, pictures) → keyword
    arguments of InputAdmit."""
    parts = [float(v) for v in text.split(",")]
    parts += [3, 2.0, 0, 3][len(parts) - 1:]
    t_ms, burst, rate, gap_ms, most = parts[:5]
    return {"window_us": t_ms * 1000, "burst": int(burst), "rate": rate, "gap_us": gap_ms * 1000,
            "max_extra": int(most)}


def pass_rates(base):
    """The stream's and the display's rates the pass ran at, from its log."""
    try:
        with open(base + ".server.log", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.search(r"cadence: (\d+)(?:\.\d+)? Hz display, (\d+) fps stream", line)
                if m:
                    return int(m.group(2)), int(m.group(1))
    except OSError:
        pass
    return None, None


def lock_line(base):
    """The host's end-of-session line on the lattice (plan « glissade »): its
    period and the gate's interval, in ns, or (None, None)."""
    try:
        with open(base + ".server.log", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.search(r"cadence lock: period (\d+) ns, interval (\d+) ns", line)
                if m:
                    return int(m.group(1)), int(m.group(2))
    except OSError:
        pass
    return None, None


def lattice_period_ns(base, hz):
    """The lattice's period for a pass: the host's own, from its end-of-session
    line, else one period of the display's rate in the log."""
    period_ns, _ = lock_line(base)
    return period_ns or (10 ** 9 // hz if hz else 0)


def pointer_drawn_in(base):
    """True when the pass ended with the pointer drawn into the picture: a
    pointer that moved alone was then a picture the gate decided on."""
    drawn = False
    try:
        with open(base + ".server.log", encoding="utf-8", errors="replace") as f:
            for line in f:
                if "[native] cursor: drawn into the picture" in line:
                    drawn = True
                elif "[native] cursor: handed to the client" in line:
                    drawn = False
    except OSError:
        pass
    return drawn


def gate_calls(rows, pointers=False):
    """The gate's calls in the loop's order, from a trace's rows: (decision
    time today, the picture's own time, a present or not). A present's call
    decides today on its wake-up (the host's end of conversion comes a little
    later); a pointer alone's on its wake-up, which is also its own time."""
    calls = []
    for r in rows:
        if r["kind"] != "capture":
            continue
        if r["status"] == "ok":
            calls.append((int(r["us"]), int(r["presentUs"]), True))
        elif pointers and r["status"] == "pointer":
            calls.append((int(r["us"]), int(r["us"]), False))
    return calls


def run_lock(calls, gate, lattice):
    """@p calls through @p gate locked on @p lattice, fed each present first:
    the gate's word on each call."""
    said = []
    for now_us, own_us, present in calls:
        if present:
            lattice.note(own_us * 1000)
        said.append(gate.admit(now_us, own_us, lattice))
    return said


def scene(base):
    """A game pass's scene, on the host's clock (µs), or None for the whole pass."""
    try:
        text = open(base + ".re9.txt", encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    lo = re.search(r"steady=(\d+) scene from here", text)
    hi = re.search(r"steady=(\d+) scene to here", text)
    return (int(lo.group(1)), int(hi.group(1))) if lo and hi else None


def q(xs, p):
    xs = sorted(xs)
    return xs[int(p * (len(xs) - 1))] if xs else float("nan")


def one(tag, a):
    base = os.path.join(a.dir, tag)
    rows = list(csv.DictReader(open(base + ".click-trace.csv")))
    presses = sorted(int(r["startUs"]) for r in rows if r["kind"] == "press")
    if not any(r["kind"] == "capture" and r["status"] == "ok" for r in rows):
        print("%s: no captures" % tag)
        return
    fps, hz = pass_rates(base)
    fps, hz = a.fps or fps, a.hz or hz
    if not fps or not hz:
        print("%s: no rates in the log, give --fps and --hz" % tag)
        return
    # A cadence aligned on a client on its vsync has an exact interval, which
    # only the host's end-of-session line says (or --interval-ns).
    gate = Gate(fps, hz, a.rule, interval_ns=a.interval_ns or lock_line(base)[1])
    lattice, pointers = None, False
    if a.lock:
        lattice = Lattice(a.period_ns or lattice_period_ns(base, hz))
        pointers = pointer_drawn_in(base) if a.pointers == "auto" else a.pointers == "on"
    calls = gate_calls(rows, pointers)
    window = None
    if a.inputadmit and not gate.ceiling:
        window = InputAdmit(interval_us=gate.interval_ns // 1000, display_hz=hz,
                            **parse_inputadmit(a.inputadmit))
    # The gate runs over the whole pass, as the host's did; only the scene counts.
    admitted, said, pi = [], [], 0
    for t, own, present in calls:
        if lattice is None:
            ok = gate.admit(t)
        else:
            if present:
                lattice.note(own * 1000)
            ok = gate.admit(t, own, lattice)
        said.append(ok)
        if not present:
            continue
        if window:
            # The presses handed to the OS before this wake-up.
            while pi < len(presses) and presses[pi] <= t:
                window.note_press(presses[pi])
                pi += 1
            ok = window.admit(ok, own, t)
        admitted.append((t, ok))
    caps = [t for t, _ in admitted]
    lo, hi = scene(base) or (caps[0], caps[-1])
    kept = [(t, ok) for t, ok in admitted if lo <= t <= hi]
    span = (hi - lo) / 1e6
    skipped_waits, weighted, total, next_ok = [], 0.0, 0.0, None
    # Backwards: for each new picture, the first admitted one at or after it.
    for i in range(len(kept) - 1, -1, -1):
        t, ok = kept[i]
        if ok:
            next_ok = t
        if next_ok is None:
            continue
        wait = next_ok - t
        if not ok:
            skipped_waits.append(wait / 1000)
        if i > 0:
            # Every instant since the picture before sees this one first.
            seg = t - kept[i - 1][0]
            weighted += seg * wait
            total += seg
    skipped = sum(1 for _, ok in kept if not ok)
    print("%s: %d fps stream, %d Hz display%s: %.1f new pictures/s, %.1f carried/s, %d skipped (%.1f %%), "
          "a skipped one waits p50 %.1f p90 %.1f ms, mean cost %.2f ms" % (
              tag, fps, hz, "" if a.rule == "now" else ", --" + a.rule,
              len(kept) / span, (len(kept) - skipped) / span, skipped, 100 * skipped / len(kept),
              q(skipped_waits, .5), q(skipped_waits, .9), weighted / total / 1000 if total else 0))
    if window:
        print("  input admit %s: %d presses, %d windows (%d carried on by a press, %d refused by the "
              "bucket), %d pictures more (%.2f a press, %.2f/s), %d held back by the cap, %d by the gap" % (
                  a.inputadmit, window.presses, window.windows, window.carried, window.refused,
                  window.frames, window.frames / max(1, window.presses),
                  window.frames * 1e6 / (caps[-1] - caps[0]), window.capped, window.gapped))
    elif a.inputadmit:
        print("  input admit: none under a ceiling (a stream at the display's rate)")
    if lattice is not None:
        n = gate.lock_ratio(lattice.period_ns)
        first = ("engaged %.2f s after the first present" % ((lattice.first_engaged_ns - lattice.first_ns) / 1e9)
                 if lattice.first_engaged_ns is not None else "never engaged")
        print("  lock: period %d ns, %s; %s; %d engagements, %d let go, %d resyncs, sharpness at the end %.3f; "
              "%.1f %% of the gate's calls locked (in its window %d, after an empty one %d, after a pause %d), "
              "%d of a pointer alone" % (
                  lattice.period_ns,
                  "%d periods a picture" % n if n else "an interval of no whole number of periods",
                  first, lattice.engagements, lattice.releases, lattice.resyncs, lattice.sharpness(),
                  100.0 * gate.locked_calls / max(1, gate.calls), gate.rules["window"], gate.rules["empty"],
                  gate.rules["pause"], sum(1 for c in calls if not c[2])))
    if a.parity:
        host = set(int(r["presentUs"]) for r in rows
                   if r["kind"] == "admit" and r["status"] == "grid" and r["presentUs"])
        mine = set(own for (t, own, present), ok in zip(calls, said) if present and ok)
        if host:
            both = len(host & mine)
            print("  parity: the replay takes %.1f %% of the %d pictures the host's gate took, and %.1f %% of "
                  "its own %d are the host's" % (100.0 * both / len(host), len(host),
                                                 100.0 * both / max(1, len(mine)), len(mine)))
        else:
            print("  parity: no admit rows in the trace")


# The golden train (plan « glissade »): a synthetic pass of known presents
# through the locked gate. The C++ tests hold the same counts
# (test_cadence_lock.cpp, which ports SplitMix64 and GoldenTrain line for
# line): change one, change the other.
M64 = (1 << 64) - 1
GOLDEN_SEED = 0x676C697373616465  # "glissade"


class SplitMix64:
    """The train's generator: every draw a whole uint64, as in C++."""

    def __init__(self, seed):
        self.state = seed & M64

    def next(self):
        self.state = (self.state + 0x9E3779B97F4A7C15) & M64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M64
        return z ^ (z >> 31)

    def below(self, n):
        return self.next() % n

    def between(self, lo, hi):
        """A whole number from @p lo to @p hi, both in."""
        return lo + self.below(hi - lo + 1)


class GoldenTrain:
    """A display at 240 Hz, 20 ppm fast against the host's clock, its phase
    wandering ±60 µs over 20 s; each present off its refresh by σ 350 µs (three
    draws of ±350), one in 250 by 1.5 to 2 ms more. In ten stretches: dense,
    content at 60 fps (one in 20 a refresh early or late), a pause of 2 s,
    dense, 4 s of presents with no grid, dense, a pause of 12 s, dense with one
    present in 8 missing, content at 77 fps, content at 120 fps. A pointer that
    moved alone after every 37th present of a dense stretch, and one after the
    5000th whose time is past the next present's."""

    PERIOD_NS = 4166583
    START_NS = 1000 * 10 ** 9

    def __init__(self, seed=GOLDEN_SEED):
        self.rng = SplitMix64(seed)
        # (refresh, present µs) of every present (refresh -1: no grid), then
        # the gate's calls: (decision time today µs, own time µs, refresh,
        # a present or a pointer alone).
        self.presents = []
        self.calls = []
        self.dense = []  # the dense stretches, as refresh ranges
        self._build()

    def _present_us(self, refresh):
        wave = refresh % 4800
        wave = wave if wave < 2400 else 4800 - wave
        off = wave * 50 - 60000
        for _ in range(3):
            off += self.rng.between(-350000, 350000)
        if self.rng.below(250) == 0:
            far = self.rng.between(1500000, 2000000)
            off += far if self.rng.below(2) == 0 else -far
        return (self.START_NS + refresh * self.PERIOD_NS + off) // 1000

    def _add(self, refresh, present_us=None):
        if present_us is None:
            present_us = self._present_us(refresh)
        if self.presents and present_us <= self.presents[-1][1]:
            present_us = self.presents[-1][1] + 1
        self.presents.append((refresh, present_us))

    def _build(self):
        rng = self.rng
        r = 0
        for length, kind in ((7200, "dense"), (2400, "60"), (480, "pause"), (1200, "dense"), (960, "nogrid"),
                             (2400, "dense"), (2880, "pause"), (2400, "holes"), (2400, "77"), (1200, "120")):
            end = r + length
            if kind == "dense":
                self.dense.append((r, end))
                for k in range(r, end):
                    self._add(k)
            elif kind == "60":
                for k in range(r, end, 4):
                    step = rng.below(20)
                    self._add(k + (1 if step == 0 else -1 if step == 1 and k > r else 0))
            elif kind == "nogrid":
                times = sorted(rng.below(length * self.PERIOD_NS) for _ in range(800))
                for x in times:
                    self._add(-1, (self.START_NS + r * self.PERIOD_NS + x) // 1000)
            elif kind == "holes":
                for k in range(r, end):
                    if rng.below(8) != 0:
                        self._add(k)
            elif kind == "77":
                j = 0
                while r + j * 240 // 77 < end:
                    self._add(r + j * 240 // 77)
                    j += 1
            elif kind == "120":
                for k in range(r, end, 2):
                    self._add(k)
            r = end
        last_us = 0
        for i, (refresh, present_us) in enumerate(self.presents):
            now_us = max(present_us + 200 + rng.below(600), last_us + 1)
            self.calls.append((now_us, present_us, refresh, True))
            last_us = now_us
            in_dense = any(lo <= refresh < hi for lo, hi in self.dense)
            if in_dense and i % 37 == 36:
                last_us = now_us + 1500
                self.calls.append((last_us, last_us, -1, False))
            if i == 5000 and i + 1 < len(self.presents):
                last_us = max(last_us + 1, self.presents[i + 1][1] + 100)
                self.calls.append((last_us, last_us, -1, False))


def golden_run(train, fps, lock=True):
    """The train through the gate at @p fps (on 240 Hz), locked on a lattice
    of the display's nominal period or not: the counts the C++ test holds."""
    gate = Gate(fps, 240)
    lattice = Lattice(period_ns_from_rational(240, 1)) if lock else None
    admitted = index_sum = 0
    steps = {}
    last_refresh = None
    for i, (now_us, own_us, refresh, present) in enumerate(train.calls):
        if lattice is not None:
            if present:
                lattice.note(own_us * 1000)
            ok = gate.admit(now_us, own_us, lattice)
        else:
            ok = gate.admit(now_us)
        if not ok:
            continue
        admitted += 1
        index_sum += i
        if refresh >= 0 and any(lo <= refresh < hi for lo, hi in train.dense):
            if last_refresh is not None and lattice is not None and lattice.engaged:
                steps[refresh - last_refresh] = steps.get(refresh - last_refresh, 0) + 1
            last_refresh = refresh
        else:
            last_refresh = None
    out = {"admitted": admitted, "index_sum": index_sum, "skipped": gate.skipped,
           "locked_calls": gate.locked_calls, "window": gate.rules["window"], "empty": gate.rules["empty"],
           "pause": gate.rules["pause"], "today": gate.rules["today"]}
    if lattice is not None:
        out.update(engagements=lattice.engagements, releases=lattice.releases, resyncs=lattice.resyncs,
                   ignored=lattice.ignored, phase_ns=lattice.phase_ns, acc=lattice.acc)
    return out, steps


GOLDEN = {
    "lock60": {"admitted": 5037, "index_sum": 44675457, "skipped": 10903, "locked_calls": 15036,
        "window": 4775, "empty": 3, "pause": 2, "today": 257, "engagements": 2, "releases": 1, "resyncs": 1,
        "ignored": 267, "phase_ns": 1097989685040, "acc": 17453210},
    "lock120": {"admitted": 8977, "index_sum": 77601130, "skipped": 6963, "locked_calls": 15036,
        "window": 7118, "empty": 1331, "pause": 57, "today": 471, "engagements": 2, "releases": 1,
        "resyncs": 1, "ignored": 267, "phase_ns": 1097989685040, "acc": 17453210},
    "lock50": {"admitted": 4200, "index_sum": 37247510, "skipped": 11740, "locked_calls": 0, "window": 0,
        "empty": 0, "pause": 0, "today": 4200, "engagements": 2, "releases": 1, "resyncs": 1, "ignored": 267,
        "phase_ns": 1097989685040, "acc": 17453210},
    "today60": {"admitted": 5039, "index_sum": 44690137, "skipped": 10901, "locked_calls": 0, "window": 0,
        "empty": 0, "pause": 0, "today": 5039},
}


def guard_case():
    """The guard, built by hand: it acts only when a window's start is off the
    lattice's halfway points (an engagement, a resync) and the picture comes in
    its window's last sliver. Today's gate, before the lattice engaged,
    restarted its grid on a call at 323.75 ms: its next window starts 0.7 of a
    period past a present of the 240 Hz lattice that the presents then engage.
    A present 0.4 period early on its refresh comes in the sliver. The nearest
    halfway point one interval on lies before that present, so the next window
    starts half a period after the present's refresh instead. Returns whether
    it was admitted, whether the lattice was engaged, and in ns the next
    window's start, the present's refresh and the nearest halfway point.
    test_cadence_lock.cpp builds the same case."""
    t = period_ns_from_rational(240, 1)
    lattice = Lattice(t)
    gate = Gate(60, 240)
    gate.admit(323750)
    before = gate.next_due_ns - gate.slack_us * 1000
    for k in range(80):
        lattice.note(k * t)
    present_us = (84 * t + 6 * t // 10) // 1000
    lattice.note(present_us * 1000)
    admitted = gate.admit(present_us, present_us, lattice)
    start = gate.next_due_ns - gate.slack_us * 1000
    slot = lattice.slot_ns(present_us * 1000)
    return admitted, lattice.engaged, start, slot, lattice.mid_ns(before + 4 * t)


def selftest():
    train = GoldenTrain()
    ok = True
    admitted, engaged, start, slot, nearest = guard_case()
    t = period_ns_from_rational(240, 1)
    good = admitted and engaged and nearest < slot and start == slot + t // 2
    ok = ok and good
    print("guard: the next window at %d ns, the present's refresh at %d, the nearest halfway point one interval "
          "on at %d%s" % (start, slot, nearest, " OK" if good else " FAIL"))
    print("golden train: %d presents, %d calls, last present at %d us" % (
        len(train.presents), len(train.calls), train.presents[-1][1]))
    for name, fps, lock in (("lock60", 60, True), ("lock120", 120, True), ("lock50", 50, True),
                            ("today60", 60, False)):
        got, steps = golden_run(train, fps, lock)
        want = GOLDEN.get(name)
        verdict = "" if want is None else (" OK" if want == got else " FAIL, want %s" % want)
        ok = ok and (want is None or want == got)
        print("%-8s %s%s" % (name, got, verdict))
        if steps:
            total = sum(steps.values())
            print("         dense steps while engaged: %s" % ", ".join(
                "%d: %.2f %%" % (k, 100.0 * v / total) for k, v in sorted(steps.items())))
    # A gate whose interval is no whole number of periods never locks: the
    # same pictures as today's, call for call.
    for fps in (50, 72, 90):
        lattice = Lattice(period_ns_from_rational(240, 1))
        locked, plain = Gate(fps, 240), Gate(fps, 240)
        for now_us, own_us, refresh, present in train.calls:
            if present:
                lattice.note(own_us * 1000)
            if locked.admit(now_us, own_us, lattice) != plain.admit(now_us):
                print("FAIL: at %d fps the locked gate differs from today's" % fps)
                ok = False
                break
    print("selftest %s" % ("passed" if ok else "FAILED"))
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("tags", nargs="*")
    ap.add_argument("--dir", default=OUT)
    ap.add_argument("--fps", type=int, default=0, help="the stream's rate (default: the pass's)")
    ap.add_argument("--hz", type=int, default=0, help="the display's rate (default: the pass's)")
    rule = ap.add_mutually_exclusive_group()
    rule.add_argument("--before", dest="rule", action="store_const", const="before",
                      help="the gate until 09/10/2026: re-anchored on a present later than a display period")
    rule.add_argument("--advance", dest="rule", action="store_const", const="advance",
                      help="a late present moves the grid on by whole intervals (Android TV bench, 08/10)")
    ap.set_defaults(rule="now")
    ap.add_argument("--inputadmit", metavar="T[,B,R,S,K]",
                    help="the admission window after a press, on the pass's presses (ms, windows, "
                         "windows a second, ms, pictures)")
    ap.add_argument("--lock", action="store_true",
                    help="the gate locked on the display's presents (plan « glissade »)")
    ap.add_argument("--period-ns", type=int, default=0,
                    help="the lattice's period (default: the host's, else the display's rate)")
    ap.add_argument("--interval-ns", type=int, default=0,
                    help="the gate's exact interval, for a cadence aligned on a client on its vsync "
                         "(default: the host's, else 1e6 / fps rounded to the µs)")
    ap.add_argument("--pointers", choices=("auto", "on", "off"), default="auto",
                    help="with --lock, a pointer alone through the gate (auto: when the pass drew it in)")
    ap.add_argument("--parity", action="store_true",
                    help="how many of the host's gate pictures (admit rows) the replay takes")
    ap.add_argument("--selftest", action="store_true", help="the golden train, against the C++ tests' counts")
    a = ap.parse_args()
    if a.selftest:
        raise SystemExit(0 if selftest() else 1)
    if not a.tags:
        ap.error("give a pass's tag, or --selftest")
    for tag in a.tags:
        one(tag, a)


if __name__ == "__main__":
    main()
