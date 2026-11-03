#!/usr/bin/env python3
"""The access point's DSCP -> Wi-Fi queue table, read from the station's own
counters (D0.4). Run as root, the Wi-Fi interface associated (no IP needed).

usage: ap_table.py --wifi wlp3s0 --wired enp2s0 [--dir both|down|up]
                   [--frames 300] [--pps 150]

mac80211 counts every data frame a station receives and sends per 802.11 TID
(`iw dev <wifi> station dump -v`, the MSDU table). Marked frames go:
  - down: out of the wired port, addressed to the Wi-Fi interface's MAC. The
    access point picks their TID from the DSCP with its own table: the answer;
  - up: out of the Wi-Fi interface, addressed to the wired port's MAC. This
    kernel picks the TID (RFC 8325 since Linux 6.8): a control with a known
    answer, which proves the counters before the down column is read.
Raw Ethernet frames (AF_PACKET) skip routing, which would otherwise keep the
traffic between two local addresses inside the machine. Both ends carry the
wired port's IPv4 address: the receiving side drops them silently as martians,
after the station has counted them.

Unlike a monitor-mode capture, this needs no second radio near the access
point and loses no frame to a bad FCS. Windows cannot do it: its Wi-Fi stack
hands frames up as plain Data, without the QoS field (pktmon, 05/10/2026).

TID -> queue: 1-2 BK, 0 and 3 BE, 4-5 VI, 6-7 VO; 16 = non-QoS frames.
"""
import argparse
import socket
import struct
import subprocess
import sys
import time

CLASSES = [("DF", 0), ("LE", 1), ("CS1", 8), ("AF11", 10), ("CS2", 16), ("AF21", 18),
           ("CS3", 24), ("AF31", 26), ("CS4", 32), ("AF41", 34), ("AF42", 36),
           ("CS5", 40), ("VA", 44), ("EF", 46), ("CS6", 48), ("CS7", 56)]
AC = {0: "BE", 1: "BK", 2: "BK", 3: "BE", 4: "VI", 5: "VI", 6: "VO", 7: "VO", 16: "non-QoS"}


def tid_table(text):
    """{tid: (rx, tx)} from `iw station dump -v`, summed over the stations listed."""
    stats = {}
    in_table = False
    for line in text.splitlines():
        cells = line.split()
        if cells[:3] == ["TID", "rx", "tx"]:
            in_table = True
            continue
        if in_table and len(cells) >= 3 and all(c.isdigit() for c in cells):
            rx, tx = stats.get(int(cells[0]), (0, 0))
            stats[int(cells[0])] = (rx + int(cells[1]), tx + int(cells[2]))
            continue
        in_table = False
    return stats


def snapshot(wifi):
    for args in (["-v"], []):
        out = subprocess.run(["iw", "dev", wifi, "station", "dump"] + args,
                             capture_output=True, text=True).stdout
        stats = tid_table(out)
        if stats:
            return stats
    sys.exit("no per-TID table in `iw dev %s station dump`: not associated, or iw too old" % wifi)


def mac(ifname):
    with open("/sys/class/net/%s/address" % ifname) as f:
        return bytes.fromhex(f.read().strip().replace(":", ""))


def ipv4(ifname):
    out = subprocess.run(["ip", "-4", "-o", "addr", "show", "dev", ifname],
                         capture_output=True, text=True).stdout.split()
    return socket.inet_aton(out[out.index("inet") + 1].split("/")[0])


def checksum(header):
    total = sum(struct.unpack("!%dH" % (len(header) // 2), header))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return ~total & 0xFFFF


def frame(dst_mac, src_mac, ip, dscp, ident, size):
    udp = struct.pack("!HHHH", 40009, 9, 8 + size, 0) + bytes([dscp]) * size
    hdr = struct.pack("!BBHHHBBH4s4s", 0x45, dscp << 2, 20 + len(udp), ident & 0xFFFF,
                      0x4000, 64, 17, 0, ip, ip)
    hdr = hdr[:10] + struct.pack("!H", checksum(hdr)) + hdr[12:]
    return dst_mac + src_mac + b"\x08\x00" + hdr + udp


def run(direction, wifi, wired, frames, pps):
    out_if, dst_mac, src_mac = ((wired, mac(wifi), mac(wired)) if direction == "down"
                                else (wifi, mac(wired), mac(wifi)))
    column = 0 if direction == "down" else 1  # down: what the station received; up: sent
    ip = ipv4(wired)
    sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, 0)
    print("# %s: out of %s, %d frames at %d/s per class, TID counts of the station (%s)"
          % (direction, out_if, frames, pps, "rx" if column == 0 else "tx"), flush=True)
    for name, dscp in CLASSES:
        before = snapshot(wifi)
        t0 = time.monotonic()
        for n in range(frames):
            sock.sendto(frame(dst_mac, src_mac, ip, dscp, n, 200 + dscp), (out_if, 0x0800))
            time.sleep(max(0.0, t0 + (n + 1) / pps - time.monotonic()))
        time.sleep(0.7)
        after = snapshot(wifi)
        delta = {tid: after[tid][column] - before.get(tid, (0, 0))[column] for tid in after}
        delta = {tid: n for tid, n in delta.items() if n}
        top = max(delta, key=delta.get) if delta else None
        print("%-5s %2d  sent %d  %s  -> %s" % (
            name, dscp, frames,
            " ".join("TID%d:%d" % (tid, n) for tid, n in sorted(delta.items())) or "nothing",
            "TID %d (%s)" % (top, AC.get(top, "?")) if top is not None else "-"), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wifi", default="wlp3s0")
    ap.add_argument("--wired", default="enp2s0")
    ap.add_argument("--dir", default="both", choices=["both", "down", "up"])
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--pps", type=int, default=150)
    a = ap.parse_args()
    # Up first: the station's own frames also teach the access point's bridge
    # where its MAC lives, before frames are sent to it.
    for direction in (["up", "down"] if a.dir == "both" else [a.dir]):
        run(direction, a.wifi, a.wired, a.frames, a.pps)


if __name__ == "__main__":
    main()
