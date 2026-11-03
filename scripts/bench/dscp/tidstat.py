#!/usr/bin/env python3
"""Per-receiver, per-TID counts of 802.11 QoS data frames in a radiotap pcap.

usage: tidstat.py capture.pcap [--sa MAC] [--top N]
Reads classic pcap (tcpdump -w), linktype 127 (radiotap). For each QoS data
frame: receiver (addr1), transmitter (addr2), source (addr3 when FromDS),
TID (QoS control & 0x0F), frame length. Prints, per (addr1, addr2), the frame
count and bytes by TID, the biggest flows first.
"""
import struct
import sys
from collections import defaultdict


def mac(b):
    return ':'.join('%02x' % x for x in b)


def bad_fcs(d):
    # radiotap: present bitmap(s) from offset 4; TSFT (bit 0, 8 bytes, 8-aligned)
    # then Flags (bit 1, 1 byte), whose 0x40 says the FCS was bad.
    present = struct.unpack('<I', d[4:8])[0]
    off = 8
    p = present
    while p & 0x80000000:
        p = struct.unpack('<I', d[off:off + 4])[0]
        off += 4
    if not present & 0x2:
        return False
    if present & 0x1:
        off = (off + 7) & ~7
        off += 8
    return bool(d[off] & 0x40)


def frames(path):
    with open(path, 'rb') as f:
        gh = f.read(24)
        magic = struct.unpack('<I', gh[:4])[0]
        endian = '<' if magic in (0xa1b2c3d4, 0xa1b23c4d) else '>'
        linktype = struct.unpack(endian + 'I', gh[20:24])[0]
        if linktype != 127:
            sys.exit('not radiotap (linktype %d)' % linktype)
        while True:
            ph = f.read(16)
            if len(ph) < 16:
                return
            ts, tus, incl, orig = struct.unpack(endian + 'IIII', ph)
            data = f.read(incl)
            yield ts + tus / 1e6, orig, data


def main():
    path = sys.argv[1]
    sa_filter = None
    top = 12
    args = sys.argv[2:]
    while args:
        a = args.pop(0)
        if a == '--sa':
            sa_filter = args.pop(0).lower()
        elif a == '--top':
            top = int(args.pop(0))
    stats = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    sources = defaultdict(lambda: defaultdict(int))
    total = 0
    for ts, orig, d in frames(path):
        if len(d) < 4:
            continue
        rtlen = struct.unpack('<H', d[2:4])[0]
        if bad_fcs(d):
            continue
        w = d[rtlen:]
        if len(w) < 26:
            continue
        fc0, fc1 = w[0], w[1]
        ftype = (fc0 >> 2) & 3
        subtype = (fc0 >> 4) & 0xF
        if ftype != 2 or not (subtype & 0x8):  # QoS data subtypes have bit 3
            continue
        to_ds = fc1 & 1
        from_ds = (fc1 >> 1) & 1
        a1, a2, a3 = mac(w[4:10]), mac(w[10:16]), mac(w[16:22])
        off = 24
        if to_ds and from_ds:
            off += 6
        if len(w) < off + 2:
            continue
        qos = w[off]
        tid = qos & 0x0F
        src = a3 if from_ds and not to_ds else a2
        if sa_filter and src != sa_filter:
            continue
        total += 1
        s = stats[(a1, a2)][tid]
        s[0] += 1
        s[1] += orig
        sources[(a1, a2)][src] += 1
    print('QoS data frames:', total)
    flows = sorted(stats.items(), key=lambda kv: -sum(v[1] for v in kv[1].values()))
    for (a1, a2), bytid in flows[:top]:
        n = sum(v[0] for v in bytid.values())
        b = sum(v[1] for v in bytid.values())
        tids = ', '.join('TID%d %d fr/%d KB' % (t, v[0], v[1] // 1024) for t, v in sorted(bytid.items()))
        srcs = ', '.join('%s:%d' % kv for kv in sorted(sources[(a1, a2)].items(), key=lambda kv: -kv[1])[:3])
        print('to %s from %s  %d frames %d KB  [%s]  src %s' % (a1, a2, n, b // 1024, tids, srcs))


if __name__ == '__main__':
    main()
