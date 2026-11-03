#!/usr/bin/env python3
"""DSCP per UDP payload size in a `tcpdump -n -v -l` text capture.

usage: tosparse.py capture.txt   (the probes give each method its own size)
"""
import re, sys, collections
c = collections.Counter(); tos = None
for line in open(sys.argv[1]):
    m = re.search(r"\(tos (0x[0-9a-f]+)", line)
    if m: tos = int(m.group(1), 16); continue
    m = re.search(r"UDP, length (\d+)", line)
    if m and tos is not None: c[(int(m.group(1)), tos >> 2)] += 1; tos = None
for (size, dscp), n in sorted(c.items()): print("size", size, "-> DSCP", dscp, "x", n)
