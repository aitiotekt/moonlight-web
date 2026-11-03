#!/usr/bin/env python3
"""One table per phase from a hostup_probe.ps1 folder (and tcp_rtt.py, worker logs).

Plan « le stream passe avant un gros envoi du PC hôte » (24/10/2026), phase M.

    hostup_report.py <dir> [--tcp file.csv ...] [--log worker.log ...]

Phases come from <dir>/marks.csv: each mark opens one, until the next. Per
phase:
- each ping target: probes, lost, median / p95 / max round trip, how many
  above 100 ms;
- the adapter: the host's upload and download, Mbit/s, mean and max over its
  one-second samples (the stream included when one runs);
- each tcp_rtt.py class (every <dir>/tcp*.csv, and --tcp): the same as a ping;
- the worker logs' freezes ([LinkFreeze], each episode at its longest; those
  ended by a report the page itself sent ~500 ms late are counted apart: a page
  whose timer ran late, not a frozen link) and [HostUpload] lines.
"""
import argparse
import csv
import glob
import os
import re
import statistics
import sys
from datetime import datetime, timedelta

FMT = "%Y-%m-%d %H:%M:%S.%f"


def ts(text):
    return datetime.strptime(text.strip(), FMT)


def pct(values, p):
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def fmt(x, digits=0):
    if x is None:
        return "-"
    return ("%%.%df" % digits) % x


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def phases_of(dirpath, first, last):
    """[(name, start, end)] from marks.csv; data before the first mark is « (before) »."""
    marks = []
    path = os.path.join(dirpath, "marks.csv")
    if os.path.exists(path):
        marks = sorted((ts(r["time"]), r["phase"]) for r in read_csv(path))
    out = []
    if not marks or (first and first < marks[0][0]):
        out.append(("(before)", first or datetime.min, marks[0][0] if marks else (last or datetime.max)))
    for i, (at, name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else (last or datetime.max) + timedelta(seconds=1)
        out.append((name, at, end))
    return out


def in_phase(at, ph):
    return ph[1] <= at < ph[2]


def rtt_row(label, rows, ph, ok_status):
    sel = [r for r in rows if in_phase(r["_t"], ph)]
    if not sel:
        return None
    rtts = [float(r["rtt_ms"]) for r in sel if r["status"] in ok_status and r["rtt_ms"]]
    lost = len(sel) - len(rtts)
    return "| %s | %d | %d | %s | %s | %s | %d |" % (
        label, len(sel), lost, fmt(pct(rtts, 50)), fmt(pct(rtts, 95)), fmt(max(rtts) if rtts else None),
        sum(1 for x in rtts if x > 100))


def nic_rates(rows):
    """[(t, up Mbit/s, down Mbit/s)] between consecutive samples."""
    out = []
    for a, b in zip(rows, rows[1:]):
        dt = (b["_t"] - a["_t"]).total_seconds()
        if dt <= 0:
            continue
        up = (int(b["sent_bytes"]) - int(a["sent_bytes"])) * 8 / dt / 1e6
        down = (int(b["received_bytes"]) - int(a["received_bytes"])) * 8 / dt / 1e6
        if up >= 0 and down >= 0:  # a counter reset gives one negative step: skip it
            out.append((b["_t"], up, down))
    return out


FREEZE = re.compile(r"^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+)\] .*\[LinkFreeze\] #(\d+)[^:]*: (\d+) ms, "
                    r"(\d\d:\d\d:\d\d\.\d+) to (?:.*?ended the gap (-?\d+) ms late)?")
HOSTUP = re.compile(r"^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+)\] .*\[HostUpload\]")


def read_freezes(paths):
    """{(log, number): (start, longest ms, page late ms)} and [HostUpload line times]."""
    eps, ups = {}, []
    for path in paths:
        with open(path, errors="replace") as f:
            for line in f:
                line = line.rstrip("\n")
                m = FREEZE.match(line)
                if m:
                    day, _, num, ms, start, late = m.groups()
                    at = ts("%s %s" % (day, start))
                    logged = ts("%s %s" % (day, m.group(2)))
                    if at > logged:  # began before midnight, told after it
                        at -= timedelta(days=1)
                    key = (path, int(num))
                    prev = eps.get(key)
                    if not prev or int(ms) > prev[1]:
                        eps[key] = (at, int(ms), int(late) if late is not None else -1)
                    continue
                m = HOSTUP.match(line)
                if m:
                    ups.append(ts("%s %s" % m.groups()))
    return eps, ups


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dir")
    ap.add_argument("--tcp", nargs="*", default=[])
    ap.add_argument("--log", nargs="*", default=[])
    a = ap.parse_args(argv)

    pings = {}
    for path in sorted(glob.glob(os.path.join(a.dir, "ping-*.csv"))):
        rows = read_csv(path)
        for r in rows:
            r["_t"] = ts(r["time"])
        if rows:
            pings["%s %s" % (rows[0]["target"], rows[0]["ip"])] = rows
    tcps = {}
    for path in sorted(set(glob.glob(os.path.join(a.dir, "tcp*.csv")) + a.tcp)):
        for r in read_csv(path):
            r["_t"] = ts(r["time"])
            tcps.setdefault("tcp %s (%s)" % (r["class"], r["dscp"]), []).append(r)
    nic = []
    if os.path.exists(os.path.join(a.dir, "nic.csv")):
        nic = read_csv(os.path.join(a.dir, "nic.csv"))
        for r in nic:
            r["_t"] = ts(r["time"])
    rates = nic_rates(nic)
    eps, ups = read_freezes(a.log)

    times = [r["_t"] for rows in list(pings.values()) + list(tcps.values()) for r in rows] + [r["_t"] for r in nic]
    if not times:
        print("nothing in %s" % a.dir)
        return 1
    for ph in phases_of(a.dir, min(times), max(times)):
        span = [t for t in times if in_phase(t, ph)]
        if not span:
            continue
        print("\n### %s: %s to %s\n" % (ph[0], min(span).strftime("%H:%M:%S"), max(span).strftime("%H:%M:%S")))
        print("| path | probes | lost | median ms | p95 ms | max ms | > 100 ms |")
        print("|---|---|---|---|---|---|---|")
        for label, rows in pings.items():
            row = rtt_row("ping " + label, rows, ph, {"Success"})
            if row:
                print(row)
        for label, rows in sorted(tcps.items()):
            row = rtt_row(label, rows, ph, {"ok"})
            if row:
                print(row)
        r = [x for x in rates if in_phase(x[0], ph)]
        if r:
            up = [x[1] for x in r]
            down = [x[2] for x in r]
            print("\nhost upload %s Mbit/s mean, %s max; download %s mean (%s, %d s)" % (
                fmt(statistics.mean(up), 1), fmt(max(up), 1), fmt(statistics.mean(down), 1),
                nic[0]["adapter"], len(r)))
        fz = [e for e in eps.values() if in_phase(e[0], ph)]
        if a.log:
            late = [e for e in fz if e[2] >= 400]
            real = [e for e in fz if e[2] < 400]
            print("freezes %d (%s ms in all, longest %s ms), %d more ended by a late page; [HostUpload] lines %d" % (
                len(real), sum(e[1] for e in real), max((e[1] for e in real), default=0), len(late),
                sum(1 for t in ups if in_phase(t, ph))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
