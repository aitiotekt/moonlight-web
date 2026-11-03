#!/usr/bin/env python3
"""A UDP "ping" without administrator rights: DNS round trips, socket kind by socket kind.

Plan « le stream passe avant un gros envoi du PC hôte », S1 bis (25/10/2026).
Windows' QoS cap emptied the queue on 25/10 but never spared the stream, though
a policy naming its executable should have won over the "Default" cap. This
stands in for the stream, from python.exe, to find out which flows a policy
does reach. Each probe is one DNS query to a resolver that answers (the box),
timed to its answer; the kinds take turns, so a burst of queueing hits all of
them alike:

    V4   an IPv4 socket opened at start, kept, on local port --v4-port;
    DS   a dual-stack IPv6 socket (IPv4 through ::ffff: addresses, as libjuice
         sends), opened at start, on --ds-port, no class;
    DST  the same with the class set the way libjuice's Windows patch sets it
         (IPV6_TCLASS and IP_TOS), on --dst-port;
    NEW  a fresh IPv4 socket for each probe, on a port Windows picks.

V4, DS and DST exist before any policy is set; NEW is born after. Nothing
listens: each socket only reads the answers to its own queries.

    udp_rtt.py <resolver> [--port 53] [--hz 5] [--secs 1200] [--out file.csv]
               [--stop file] [--kinds V4,DS,DST,NEW]

One line per probe: time,kind,lport,status,rtt_ms (status ok or timeout).
Stop early by creating the --stop file.
"""
import argparse
import os
import random
import select
import socket
import struct
import sys
import time
from datetime import datetime

IPV6_TCLASS = getattr(socket, "IPV6_TCLASS", 39)  # 39 on Windows, 67 on Linux
AF41 = 34


def query(qid, name):
    """A standard recursive query for name's A record."""
    q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    for label in name.split("."):
        q += bytes([len(label)]) + label.encode("ascii")
    return q + b"\x00" + struct.pack(">HH", 1, 1)


def v4_socket(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", port))
    return s


def ds_socket(port, ds):
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    if ds:
        # libjuice-windows-diffserv.patch: the traffic class, then IP_TOS for the IPv4-mapped peers.
        s.setsockopt(socket.IPPROTO_IPV6, IPV6_TCLASS, ds)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, ds)
    s.bind(("::", port))
    return s


def probe(s, dest, name, timeout):
    """One query on s: (status, rtt_ms or None). Late answers to earlier probes are skipped."""
    qid = random.randrange(0x10000)
    t0 = time.perf_counter()
    s.sendto(query(qid, name), dest)
    end = t0 + timeout
    while True:
        left = end - time.perf_counter()
        if left <= 0:
            return "timeout", None
        r, _, _ = select.select([s], [], [], left)
        if not r:
            return "timeout", None
        try:
            data, _ = s.recvfrom(2048)
        except OSError:
            continue  # an ICMP error from an earlier probe
        if len(data) >= 2 and struct.unpack(">H", data[:2])[0] == qid:
            return "ok", (time.perf_counter() - t0) * 1000.0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("resolver", help="an IPv4 address that answers DNS")
    ap.add_argument("--port", type=int, default=53)
    ap.add_argument("--name", default="example.com")
    ap.add_argument("--kinds", default="V4,DS,DST,NEW")
    ap.add_argument("--v4-port", type=int, default=49951)
    ap.add_argument("--ds-port", type=int, default=49952)
    ap.add_argument("--dst-port", type=int, default=49953)
    ap.add_argument("--hz", type=float, default=5.0, help="probes a second, all kinds together")
    ap.add_argument("--secs", type=float, default=1200.0)
    ap.add_argument("--timeout", type=float, default=2.0)
    ap.add_argument("--out", default="")
    ap.add_argument("--stop", default="")
    a = ap.parse_args(argv)

    kinds = [k.strip().upper() for k in a.kinds.split(",") if k.strip()]
    unknown = [k for k in kinds if k not in ("V4", "DS", "DST", "NEW")]
    if not kinds or unknown:
        ap.error("kinds are V4, DS, DST, NEW")
    v4_dest = (a.resolver, a.port)
    mapped_dest = ("::ffff:" + a.resolver, a.port, 0, 0)
    kept = {}
    if "V4" in kinds:
        kept["V4"] = v4_socket(a.v4_port)
    if "DS" in kinds:
        kept["DS"] = ds_socket(a.ds_port, 0)
    if "DST" in kinds:
        kept["DST"] = ds_socket(a.dst_port, AF41 << 2)

    out = open(a.out, "w", newline="") if a.out else sys.stdout
    out.write("time,kind,lport,status,rtt_ms\n")
    out.flush()

    period = 1.0 / a.hz
    start = time.perf_counter()
    end = start + a.secs
    n = 0
    try:
        while time.perf_counter() < end:
            if a.stop and os.path.exists(a.stop):
                break
            kind = kinds[n % len(kinds)]
            at = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            if kind == "NEW":
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                try:
                    s.bind(("0.0.0.0", 0))
                    lport = s.getsockname()[1]
                    status, rtt = probe(s, v4_dest, a.name, a.timeout)
                finally:
                    s.close()
            else:
                s = kept[kind]
                lport = s.getsockname()[1]
                status, rtt = probe(s, v4_dest if kind == "V4" else mapped_dest, a.name, a.timeout)
            out.write("%s,%s,%d,%s,%s\n" % (at, kind, lport, status, "" if rtt is None else "%.2f" % rtt))
            out.flush()
            n += 1
            # A steady pace: a slow probe eats into the next wait, never adds to it.
            wait = start + n * period - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
            else:
                start = time.perf_counter() - n * period
    except KeyboardInterrupt:
        pass
    finally:
        if out is not sys.stdout:
            out.close()
        for s in kept.values():
            s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
