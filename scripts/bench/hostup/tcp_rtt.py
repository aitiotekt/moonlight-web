#!/usr/bin/env python3
"""A marked "ping" without administrator rights: TCP handshake times, DSCP by DSCP.

Plan « le stream passe avant un gros envoi du PC hôte » (24/10/2026), phase M.
The question is whether a marked packet skips the queue that the host's own
upload fills. ICMP cannot carry a class from a plain Windows process (ping's
TOS option is ignored, a raw socket needs an administrator), but a TCP socket
can: Windows honours IP_TOS below CS6 for a user process (D0, 05/10/2026). So
this opens a connection to a port the target listens on, with the class set
before connect(), and times the handshake: the SYN goes up the loaded path
carrying the class, the SYN-ACK comes back. The connection is then reset
(SO_LINGER 0), so the server keeps nothing.

    tcp_rtt.py <host> [--port 80] [--classes DF,AF41] [--hz 5] [--secs 600]
               [--out file.csv] [--stop file]

The classes take turns, one probe each, so a burst of queueing hits all of
them alike. The target must listen on the port: a refused connection is
retried by Windows for about a second, which would read as a slow path. One
line per probe: time,class,dscp,status,rtt_ms (status ok, timeout, refused,
error). Stop early by creating the --stop file.
"""
import argparse
import os
import socket
import struct
import sys
import time
from datetime import datetime

CLASSES = {"DF": 0, "CS1": 8, "AF11": 10, "CS3": 24, "AF41": 34, "CS5": 40, "EF": 46}
IPV6_TCLASS = getattr(socket, "IPV6_TCLASS", 39)  # 39 on Windows, 67 on Linux


def dscp_of(name):
    t = name.strip().upper()
    if t in CLASSES:
        return CLASSES[t]
    v = int(t)
    if not 0 <= v <= 63:
        raise ValueError("DSCP %d is out of 0-63" % v)
    return v


def probe(host, port, family, dscp, timeout):
    """One handshake: (status, rtt_ms or None)."""
    s = socket.socket(family, socket.SOCK_STREAM)
    try:
        if family == socket.AF_INET6:
            s.setsockopt(socket.IPPROTO_IPV6, IPV6_TCLASS, dscp << 2)
        else:
            s.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, dscp << 2)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("hh", 1, 0))
        s.settimeout(timeout)
        t0 = time.perf_counter()
        try:
            s.connect((host, port))
        except socket.timeout:
            return "timeout", None
        except ConnectionRefusedError:
            return "refused", (time.perf_counter() - t0) * 1000.0
        except OSError as e:
            return "error:%s" % (e.errno,), None
        return "ok", (time.perf_counter() - t0) * 1000.0
    finally:
        s.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("host")
    ap.add_argument("--port", type=int, default=80)
    ap.add_argument("--classes", default="DF,AF41")
    ap.add_argument("--hz", type=float, default=5.0, help="probes a second, all classes together")
    ap.add_argument("--secs", type=float, default=600.0)
    ap.add_argument("--timeout", type=float, default=2.0)
    ap.add_argument("--out", default="")
    ap.add_argument("--stop", default="")
    a = ap.parse_args(argv)

    classes = [(c.strip().upper(), dscp_of(c)) for c in a.classes.split(",") if c.strip()]
    if not classes:
        ap.error("no class")
    family = socket.AF_INET6 if ":" in a.host else socket.AF_INET
    out = open(a.out, "w", newline="") if a.out else sys.stdout
    out.write("time,class,dscp,status,rtt_ms\n")
    out.flush()

    period = 1.0 / a.hz
    start = time.perf_counter()
    end = start + a.secs
    n = 0
    try:
        while time.perf_counter() < end:
            if a.stop and os.path.exists(a.stop):
                break
            name, dscp = classes[n % len(classes)]
            at = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            status, rtt = probe(a.host, a.port, family, dscp, a.timeout)
            out.write("%s,%s,%d,%s,%s\n" % (at, name, dscp, status, "" if rtt is None else "%.2f" % rtt))
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
