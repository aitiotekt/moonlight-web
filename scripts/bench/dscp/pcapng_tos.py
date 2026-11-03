#!/usr/bin/env python3
"""DSCP per UDP payload size in a pcapng capture (pktmon etl2pcap, Wireshark).

usage: pcapng_tos.py capture.pcapng [--src IP] [--src-mac MAC]

The Windows probe (win_dscp_probe.py) gives each method its own payload size;
this counts, per size, which DSCP arrived. --src keeps the IPv4 packets from
that address; --src-mac keeps the Ethernet frames from that station, IPv6
included (a stream's one direction, whatever addresses its pair took). Ethernet frames, or the 802.11 ones
pktmon hands for a Wi-Fi adapter (under the Ethernet link type); IPv4
and IPv6 (whose Traffic Class carries the DSCP the same way). A packet seen by
several pktmon components is counted once per component: compare the shares,
not the totals.
"""
import socket
import struct
import sys
from collections import Counter


def blocks(path):
    with open(path, 'rb') as f:
        data = f.read()
    off = 0
    endian = '<'
    while off + 12 <= len(data):
        btype, blen = struct.unpack_from(endian + 'II', data, off)
        if btype == 0x0A0D0D0A:  # section header: its byte-order magic sets the endianness
            magic = data[off + 8:off + 12]
            endian = '<' if magic == b'\x4d\x3c\x2b\x1a' else '>'
            btype, blen = struct.unpack_from(endian + 'II', data, off)
        if blen < 12:
            break
        yield btype, data[off + 8:off + blen - 4], endian
        off += blen


def packets(path):
    for btype, body, e in blocks(path):
        if btype == 6:  # enhanced packet block
            caplen = struct.unpack_from(e + 'I', body, 12)[0]
            yield body[20:20 + caplen]


def main():
    path = sys.argv[1]
    src = sys.argv[sys.argv.index('--src') + 1] if '--src' in sys.argv else None
    mac = None
    if '--src-mac' in sys.argv:
        mac = bytes.fromhex(sys.argv[sys.argv.index('--src-mac') + 1].replace('-', '').replace(':', ''))
    count = Counter()
    for p in packets(path):
        if len(p) < 14:
            continue
        if mac and p[6:12] != mac:
            continue
        eth = struct.unpack_from('!H', p, 12)[0]
        off = 14
        if eth == 0x8100:  # one VLAN tag
            eth = struct.unpack_from('!H', p, 16)[0]
            off = 18
        if eth not in (0x0800, 0x86DD):
            # pktmon on a Wi-Fi adapter hands 802.11 frames under the Ethernet
            # link type: the IP header follows the LLC/SNAP header.
            for snap, kind in ((bytes.fromhex('aaaa030000000800'), 0x0800),
                               (bytes.fromhex('aaaa0300000086dd'), 0x86DD)):
                i = p.find(snap, 0, 64)
                if i >= 0:
                    eth, off = kind, i + 8
                    break
        if eth == 0x0800 and len(p) >= off + 28:
            ihl = (p[off] & 0x0F) * 4
            if p[off + 9] != 17:
                continue
            if src and socket.inet_ntoa(p[off + 12:off + 16]) != src:
                continue
            dscp = p[off + 1] >> 2
            ulen = struct.unpack_from('!H', p, off + ihl + 4)[0]
            count[('v4', ulen - 8, dscp)] += 1
        elif eth == 0x86DD and len(p) >= off + 48:
            if p[off + 6] != 17:
                continue
            tclass = ((p[off] & 0x0F) << 4) | (p[off + 1] >> 4)
            ulen = struct.unpack_from('!H', p, off + 40 + 4)[0]
            count[('v6', ulen - 8, tclass >> 2)] += 1
    for (fam, size, dscp), n in sorted(count.items()):
        print('%s size %d -> DSCP %d x %d' % (fam, size, dscp, n))


if __name__ == '__main__':
    main()
