#!/usr/bin/env python3
"""TIDs of the frames to one station from one source, per class window.

usage: tidtime.py capture.pcap <station-mac> <source-mac> <udptos-output>
"""
import os, struct, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tidstat import frames, bad_fcs, mac
pcap, sta, src_mac, plan = sys.argv[1], sys.argv[2].lower(), sys.argv[3].lower(), sys.argv[4]
windows = []
for line in open(plan):
    p = line.split()
    if len(p) >= 5: windows.append((p[0], int(p[1]), float(p[3]), float(p[4])))
per = {w[0]: Counter() for w in windows}
lens = {w[0]: Counter() for w in windows}
for ts, orig, d in frames(pcap):
    rtlen = struct.unpack('<H', d[2:4])[0]
    w = d[rtlen:]
    if len(w) < 26 or bad_fcs(d): continue
    if (w[0] >> 2) & 3 != 2 or not ((w[0] >> 4) & 8): continue
    fc1 = w[1]; to_ds, from_ds = fc1 & 1, (fc1 >> 1) & 1
    if mac(w[4:10]) != sta: continue
    src = mac(w[16:22]) if from_ds and not to_ds else mac(w[10:16])
    if src != src_mac: continue
    off = 30 if (to_ds and from_ds) else 24
    tid = w[off] & 0x0F
    for name, dscp, a, b in windows:
        if a - 0.2 <= ts <= b + 0.5:
            per[name][tid] += 1; lens[name][orig] += 1
for name, dscp, a, b in windows:
    print("%-5s DSCP %2d  -> %s   (lengths %s)" % (name, dscp, dict(per[name]) or "none decoded",
          dict(lens[name].most_common(2))))
