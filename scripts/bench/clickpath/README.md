# clickpath — the click's two waits outside the codec (plan « attente »)

The bench of 06/10/2026 (120 fps, the RTX encoding, a 2560×1440 virtual display
at 120 Hz, the UM790Pro on the cable) split a click into stages. Two of them
dominate and nothing targeted them:

- **A. Host → captured picture, 13-15 ms**: from the host receiving the click
  to the present of the picture that shows the flag. Every codec pays it.
- **B. The page's GPU wait in PyroWave's WebGPU decode, ~4.5 ms of 6.3**: the
  GPU works ~1.8 ms of decode and ~0.3 ms of display.

Two scripts split each one further. Both read a content-age pass
(`scripts/bench/content-age/pass.py`, through `local_matrix.py` or
`wifi/series.py`) in `bench-out/content-age/`.

## A — hostpath.py

What the pass needs:

- `clicktrace=1` in `MW_NATIVE_TUNING` (or `native_tuning`). The host's
  engine then writes `click-trace-<pid>-<ms>.csv` next to the worker's log when
  the session ends (copied as `<tag>.click-trace.csv`):
  - each press handed to the OS (`SendInput`, and when it was queued for a
    SYSTEM worker's follower thread);
  - each wake-up of the capture: when it started waiting, when it returned and
    with what; for a frame, its present (DDA's `LastPresentTime`, WGC's
    `SystemRelativeTime` before the clamp), DDA's `LastMouseUpdateTime` and
    `AccumulatedFrames`; then DWM's timing (`DwmGetCompositionTimingInfo`: last
    vblank, period, last composition, frame count).

  The relay also logs each stamped input (`click trace: input stamp …
  received at …, handled at …`).
- `MW_LATENCY_FLAG_TRACE=1` in the server's environment (read when the flag
  arms, at startup): the flag's line gains the hook's moment, and after each
  flag the overlay waits for DWM's next composition (`DwmFlush`) and logs it
  with DWM's timing. It blocks the overlay's thread for at most a frame.
- To compare DDA and WGC on the same bench: `MW_CAPTURE=wgc` in the worker's
  environment (DDA is the default).

```
python scripts/bench/clickpath/hostpath.py <tag> [--clicks]
python scripts/bench/clickpath/hostpath.py <tag> --target <mw-click-target log>
```

The legs, all on the host's clock: `queue` (relay → SendInput), `sendinput`,
`hook` (→ the flag's hook, or the application's WM_LBUTTONDOWN), `raise` (→
flag painted, or Present returned), `composed` (→ DWM composed it, or the OS
says it reached the screen), `present` (→ the present of the frame that showed
it), `handoff` (that present → the capture handed it over), `host` (the
host's whole share). And `vblank` (where in DWM's refresh the flag went up),
`wait` (to the next vblank), `between` (frames presented after the flag that
did not carry it).

The frame that showed the flag is the client's, when the pass has
`<tag>.json` and `<tag>.clicks.frames.csv`; otherwise the first presented after
the flag was composed. For a pass made since `652fc726`, give `--from-draw`:
the probe then dates the flag from its frame's draw, before the renderer reads
it back, and the frame is the one whose draw holds that moment, not the last
one drawn before it. Without the option, such a pass is credited to the frame
before (a host share far too small); with it, an older pass may be credited to
the frame after.

## A, every frame — presentmon.py

`hostpath.py` follows the click's frame. `presentmon.py` follows all the frames
of an application or a game, from its present to the capture, from PresentMon
run beside the pass:

```
PresentMon-x64.exe --process_name mw-click-target.exe --process_name re9.exe ^
  --output_file bench-out\content-age\<tag>.presentmon.csv --qpc_time --no_console_stats ^
  --session_name mw-attente --stop_existing_session --timed 900 --terminate_after_timed
PresentMon-x64.exe --session_name mw-attente --terminate_existing_session   (at the end)
python scripts/bench/clickpath/presentmon.py <tag> [--target <mw-click-target log>]
```

PresentMon 2 (AMD's build ships with its driver, in `C:\Program Files\AMD\CNext\CNext`)
traces without elevation for a member of « Performance Log Users ». The pass
needs `clicktrace=1` too: DDA's `LastPresentTime` of every picture. Per
process: frames a second, present modes, frames never shown, then per frame
`shown` (present → on the screen, by PresentMon), `dda` (that moment → DDA's
present for the picture that carried it: the two agree when ~0), `handoff`,
`total` (present → handed over), and the compositions' rhythm. A game driven
beside the pass writes `<tag>.re9.txt`, whose `scene from here` and `scene to
here` lines bound the frames counted.

## A, on the client's clock — clicksplit.py

`hostpath.py` splits the host's share on the host's clock. `clicksplit.py`
splits the whole click at the capture, on the client's clock: click → capture
(the way up and the host) and capture → drawn (encode, way down, decode, draw),
for the frame that showed the flag (the probe since 652fc726). Means add up to
the click's; medians do not. A glob pools passes (ABBA arms):

```
python scripts/bench/clickpath/clicksplit.py "al2-lx-vdd120-r*" "al2-lx-vdd240-r*"
```

The probe clicks at a random phase of the host's refresh since 5c96775d: before
it, a click left right after a sampled picture, at one phase of a host that
paces its frames on a vblank (design §9.4).

## A, the stream's gate — gatesim.py

The host encodes only the presents its gate admits (`core/FrameCadence.h`).
`gatesim.py` replays that gate on a pass's captures (`clicktrace=1`), at the
pass's rates or any other, and says what the stream would have carried: new
pictures and carried ones a second, those skipped, how long a skipped one's
change waited for the next admitted picture, and that wait averaged over every
instant. Its `Gate` is a copy of `FrameCadence::admit()`: change both together.

```
python scripts/bench/clickpath/gatesim.py <tag> [--fps 50] [--hz 240] [--before | --advance]
```

`--before` replays the gate the passes of 08-09/10/2026 ran with: a present
later than one refresh of the display re-anchored the grid on itself. With it,
the replay gives the host's own "not carried" count to within 2. The gate
since the fix of 09/10/2026 (Cadence session, design §9.6.1) moves the grid
only when a tick's window closed with nothing in it. On RE9 (~77 pictures a
second) on the virtual display at 240 Hz, a 60 fps stream carries 48.4 a second
`--before` and 59.6 now; a 50 fps stream 40.7 and 49.7.

`--advance` is the change the Android TV bench proposed (08/10/2026): a late
present moves the grid on by whole intervals from the tick it missed. It gives
the same rates on RE9, but a game at the stream's own rate, a refresh early or
late, then beats against the grid (design §9.6.1).

`--inputadmit T[,B,R,S,K]` adds the admission window after a press (plan
« inputadmit », 13/10/2026) on the pass's own presses: for T ms after each
press every present goes through, the gate's grid untouched. B windows ahead
and R more a second (3 and 2), S the least gap between two pictures (0), K the
most pictures a window adds (3). Its `InputAdmit` is a copy of
`core/InputAdmit.h`, as `Gate` is of `FrameCadence`.

## A, the window after a press — inputsim.py

At 60 fps on the virtual display at 240 Hz, the picture that carries a click
waits for the gate's next window (9.7 ms at the median, `docs/bench-native-host.md`
§8v.5). `inputsim.py` replays the admission window, and the rules it was
chosen against, on the passes of 09-13/10 and says what each costs:

```
python scripts/bench/clickpath/inputsim.py [--sections flag,target,game,display,spam,encode,release]
                                           [--variants "base next 16.7 33,3,2,0,3"]
```

- `flag`: the bench's flag (`c60-um-A*`): the `present` leg, pictures more a
  click, at 60 and 120 fps;
- `target`: `mw-click-target`, which reacts in 1 to 7 ms;
- `game`: RE9 at 62 to 78 pictures a second, presses at random moments and the
  game's picture 8, 16 or 24 ms after;
- `display`: what a client that paints at its vsync (60, 120, 144 Hz) shows
  around each click;
- `spam`: presses faster than the bucket, and a click's wait when it is empty;
- `encode`: a slower encoder, the loop busy 3 to 8 ms an encode;
- `release`: the releases taken as presses too.

Its replay is checked on the pictures the client received: the gate's phase is
set on them, and a loop busy over 50 ms (`c60-um-A3`, at its first click) is
taken as a re-send through the gate. It then keeps 96 to 99 % of the client's
pictures on the three A passes.

Since the window was written, the Windows host's trace has `admit` rows
(`clicktrace=1`): `press` for each press the window was told of (keys and pads
too, not only mouse buttons), `grid` or `window` for each present it encoded,
with its present. `inputsim.py` then takes the host's presses and the gate's
pictures from there, `hostpath.py` says how many clicks' frames the window
sent, and `content-age/fluid.py` tells the window's frames from the grid's.

## A, the gate locked on the display — gatesim.py --lock, locksim.py

Today's gate keeps its grid in whole microseconds: 16 666 µs for 60 fps, so on
the virtual display at 240 Hz it slips some 36 µs a second along the presents.
Every two minutes or so a window's edge lies on a present, and for ~30 s the
gaps between pictures go 12.5 / 20.8 ms instead of 16.7 (`docs/bench-native-host.md`
§8w.8). The locked gate (plan « glissade », 14/10/2026) follows the display's
presents with a lattice, and keeps the start of each window halfway between
two of its presents.

`gatesim.py --lock` replays it on a pass. Its `Lattice` is a copy of
`core/PresentLattice.h`, and `Gate._admit_locked()` of the locked branch of
`FrameCadence`: change them together. Both work in whole nanoseconds, and every
division rounds down.

- The lattice is fed each present's own time, skipped or not, before the gate
  decides. Its phase follows a present's offset e / 32, bounded to ±T/4.
- It engages once 64 presents are in and the mean |e| is under T/10, and lets
  go above T/5. After a pause of 10 s, or of 1 s that left the phase beyond T/4,
  the phase starts again on the present.
- While it is engaged and the stream's interval is N >= 2 display periods to
  within 0.2 %, the gate decides on the picture's own time: a present's, a
  pointer's wake-up. Otherwise it is today's gate, call for call.
- The lattice's period and the gate's interval are the host's (its line
  `cadence lock: period <ns> ns, interval <ns> ns`, the interval as its gate
  held it: an aligned cadence's exact one, a ceiling's shortened one), else
  `--period-ns` and `--interval-ns`, else one period of the display's rate and
  1e6 / fps rounded to the µs. A pointer alone goes through the gate when the
  pass drew it into the picture (`--pointers auto|on|off`).

`--parity` says how many of the pictures the host's gate took (the trace's
`admit` rows) the replay takes too. On the passes of 13/10 the gate of today
finds 97.8 to 99.7 % of them. A client on its vsync is the exception (31 %):
the exact interval of its aligned cadence is in no log of that day. Since the
lock's code (plan « glissade » P1), the `admit` rows also say whether the
host's gate decided locked (`locked`) and the lattice's point nearest the
picture (`latticeUs`). `--selftest` runs the golden train, a synthetic pass of
known presents through the locked gate, and checks the counts that
`test_cadence_lock.cpp` holds.

```
python scripts/bench/clickpath/gatesim.py <tag> --lock [--parity] [--period-ns 4166666]
python scripts/bench/clickpath/gatesim.py --selftest
```

`locksim.py` gives the table per family of passes, today's gate against the
locked one: the steps a whole refresh off the stream's interval (those of the
content, whose refresh had no present, and those of the gate), the pictures
carried a second, the wait of a change for the next carried picture, and the
lattice's engagements. The `vsync` family replays the passes of a client on its
vsync with the exact interval of their aligned cadence, 0 and ±15 ppm off.

```
python scripts/bench/clickpath/locksim.py [--family dense,target,game,clock,linux,mac,vsync] [--passes]
```

## B — gpuwait.py

What the pass needs: `localStorage.mw_ultra_trace = '1'` in the client's page
before the stream starts. `UltraPlayer` then keeps every frame's timeline
(`__mwUltraPlayer.trace`): in, decode starts, submitted, work done, VideoFrame
made, and the GPU's own timestamps around the decode and the present passes on
every frame; and after one frame in eight, when nothing waits, an empty
timestamped pass, the reference for Chrome's own submit → work done. `pass.py`
writes it as `<tag>.ultratrace.json`.

Chrome rounds timestamp queries to 100 µs unless its bench profile runs with
`--enable-webgpu-developer-features`; the script says when it sees rounded
values.

```
python scripts/bench/clickpath/gpuwait.py <tag>
```

The GPU's clock is put on the page's from what the two cannot break: the GPU
starts no earlier than the submit and ends no later than the work-done
callback. Over each 2 s window, frames and references together, that bounds
the offset; both bounds are printed, and the split of submit → work done into
before the GPU starts, the GPU at work, and after it ends.

## B, away from any stream — scripts/bench/ultra/gpuwait_lab.py

The same submissions as `UltraPlayer` in a Chrome of its own, one GPU at a time
(`--chrome-arg=--use-adapter-luid=<high>,<low>`), no MoonlightWeb instance:
an empty command buffer, an empty timestamped pass, or a corpus frame decoded
and presented into a WebGPU `OffscreenCanvas` then made a `VideoFrame`. Paced
back to back, at 120 fps (`pace=tick`) or on animation frames; waited on by
`onSubmittedWorkDone` or `mapAsync`; on the main thread or a worker; with or
without a nudge (a cheap command every `nudgeEvery` ms while the submission
waits, which makes Chrome's GPU process look at its fences again). The page is
served cross-origin isolated, so the trace counts in µs.

```
python scripts/bench/ultra/gpuwait_lab.py --tag b1-rtx --rounds 2 --chrome-arg=--use-adapter-luid=0,81301
python scripts/bench/clickpath/gpuwait.py b1-rtx-decode-tick-r0 --dir bench-out/ultra-lab
```

Each run writes `<tag>-<case>[-rN].ultratrace.json` (what `gpuwait.py` reads)
and `.json` (the parameters and a summary), and prints a line: submit → done,
its split by the GPU's timestamps (before the GPU starts, at work, after it
ends), and the main thread's task time per frame (CDP `TaskDuration`). A remote
Chrome (the UM790Pro's): `--remote-cdp` and `--http-port` through SSH tunnels,
as `decoder_lab.py`. Findings: design `ultra-lan-poc.md` §6.25.
