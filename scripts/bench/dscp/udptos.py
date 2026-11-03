#!/usr/bin/env python3
"""Marked UDP, one DSCP class at a time, to a host on the Wi-Fi (D0.4).

usage: udptos.py <dest-ip> [pps] [secs] [gap]  -> prints one line per class:
    <name> <dscp> <payload bytes> <start epoch> <end epoch>
Each class has its own payload size too, so its frames are told apart by
length as well as by time. Linux honours IP_TOS from a user socket.
"""
import socket, sys, time
CLASSES = [("DF", 0, 300), ("CS1", 8, 340), ("AF11", 10, 380), ("AF41", 34, 420),
           ("CS5", 40, 460), ("VA", 44, 500), ("EF", 46, 540), ("CS6", 48, 580), ("CS7", 56, 620)]
dest = sys.argv[1]
pps = int(sys.argv[2]) if len(sys.argv) > 2 else 100
secs = float(sys.argv[3]) if len(sys.argv) > 3 else 5
gap = float(sys.argv[4]) if len(sys.argv) > 4 else 2
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for name, dscp, size in CLASSES:
    s.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, dscp << 2)
    payload = bytes([dscp]) * size
    t0 = time.time(); n = 0
    while time.time() - t0 < secs:
        s.sendto(payload, (dest, 9))
        n += 1
        time.sleep(max(0.0, t0 + n / pps - time.time()))
    print(name, dscp, size, "%.3f" % t0, "%.3f" % time.time(), n, flush=True)
    time.sleep(gap)
