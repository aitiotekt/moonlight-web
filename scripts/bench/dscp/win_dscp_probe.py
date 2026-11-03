#!/usr/bin/env python3
"""Which ways of marking a UDP packet's DSCP actually reach the wire on Windows.

Plan « le son et la priorité des paquets », D0.2. libjuice gives up on
Windows (« IP_TOS has been intentionally broken… »), so the Windows native
host sends every packet with DSCP 0. This tries each way a process can ask,
one after the other, each with a payload size of its own so a capture on the
receiving side (tcpdump -v on a Linux box, or pktmon) tells them apart:

  size  method
  301   plain              nothing asked (the reference: DSCP 0)
  303   ip_tos             setsockopt(IP_TOS, dscp<<2) — Microsoft: "Do not use"
  305   cmsg               WSASendMsg with an IP_TOS control message, per packet
                           (what MsQuic 2.6 does on recent Windows)
  307   qwave_type         qWAVE QOSAddSocketToFlow with a traffic type (Voice):
                           the type's own DSCP, no privilege asked
  309   qwave_value        qWAVE QOSSetFlow(QOSSetOutgoingDSCPValue): the exact
                           value, Administrators or Network Configuration
                           Operators only
  311-317 toggle           one socket, IP_TOS changed before every packet
                           (EF, AF41, AF11, 0 in turn), as libjuice would
  319-323 dual             libjuice's own socket, IPv6 dual stack to a v4-mapped
                           peer: IPV6_TCLASS (319), IP_TOS (321), both (323)

usage: python win_dscp_probe.py <dest-ip> [dscp=46] [count=20] [port=9]
Prints, per method, whether each call succeeded; the capture says the rest.
The destination port needs no listener (a closed port answers ICMP).
"""
import ctypes
import ctypes.wintypes as wt
import socket
import struct
import sys
import time

ws2 = ctypes.WinDLL("ws2_32", use_last_error=True)
try:
    qwave = ctypes.WinDLL("qwave", use_last_error=True)
except OSError:
    qwave = None

IPPROTO_IP = 0
IP_TOS = 3
SIO_GET_EXTENSION_FUNCTION_POINTER = 0xC8000006


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wt.DWORD), ("Data2", wt.WORD), ("Data3", wt.WORD), ("Data4", ctypes.c_ubyte * 8)]


WSAID_WSASENDMSG = GUID(0xA441E712, 0x754F, 0x43CA, (ctypes.c_ubyte * 8)(0x84, 0xA7, 0x0D, 0xEE, 0x44, 0xCF, 0x60, 0x6D))


class WSABUF(ctypes.Structure):
    _fields_ = [("len", wt.ULONG), ("buf", ctypes.c_void_p)]


class SOCKADDR_IN(ctypes.Structure):
    _fields_ = [("sin_family", ctypes.c_short), ("sin_port", ctypes.c_ushort),
                ("sin_addr", ctypes.c_ubyte * 4), ("sin_zero", ctypes.c_char * 8)]


class WSAMSG(ctypes.Structure):
    _fields_ = [("name", ctypes.c_void_p), ("namelen", ctypes.c_int), ("lpBuffers", ctypes.POINTER(WSABUF)),
                ("dwBufferCount", wt.DWORD), ("Control", WSABUF), ("dwFlags", wt.DWORD)]


class QOS_VERSION(ctypes.Structure):
    _fields_ = [("MajorVersion", wt.USHORT), ("MinorVersion", wt.USHORT)]


QOSTrafficTypeVoice = 4
QOS_NON_ADAPTIVE_FLOW = 0x00000002
QOSSetOutgoingDSCPValue = 2


def sockaddr(ip, port):
    sa = SOCKADDR_IN()
    sa.sin_family = socket.AF_INET
    sa.sin_port = socket.htons(port)
    sa.sin_addr = (ctypes.c_ubyte * 4)(*socket.inet_aton(ip))
    return sa


def send_n(sock, ip, port, size, count, tag):
    payload = (tag * size)[:size]
    for _ in range(count):
        sock.sendto(payload, (ip, port))
        time.sleep(0.01)


def method_plain(ip, port, dscp, count):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send_n(s, ip, port, 301, count, b"P")
    s.close()
    return "sent"


def method_ip_tos(ip, port, dscp, count):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(IPPROTO_IP, IP_TOS, dscp << 2)
        got = s.getsockopt(IPPROTO_IP, IP_TOS)
        note = "setsockopt ok, getsockopt reads %d" % got
    except OSError as e:
        note = "setsockopt failed: %s" % e
    send_n(s, ip, port, 303, count, b"T")
    s.close()
    return note


def method_cmsg(ip, port, dscp, count):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", 0))
    fn = ctypes.c_void_p()
    nbytes = wt.DWORD()
    guid = WSAID_WSASENDMSG
    r = ws2.WSAIoctl(ctypes.c_size_t(s.fileno()), wt.DWORD(SIO_GET_EXTENSION_FUNCTION_POINTER),
                     ctypes.byref(guid), ctypes.sizeof(guid), ctypes.byref(fn), ctypes.sizeof(fn),
                     ctypes.byref(nbytes), None, None)
    if r != 0 or not fn.value:
        return "no WSASendMsg (WSAIoctl %d, error %d)" % (r, ctypes.get_last_error())
    proto = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_size_t, ctypes.POINTER(WSAMSG), wt.DWORD,
                               ctypes.POINTER(wt.DWORD), ctypes.c_void_p, ctypes.c_void_p)
    send_msg = proto(fn.value)
    sa = sockaddr(ip, port)
    data = (b"C" * 305)
    dbuf = ctypes.create_string_buffer(data, len(data))
    wbuf = WSABUF(len(data), ctypes.cast(dbuf, ctypes.c_void_p))
    # WSACMSGHDR { SIZE_T cmsg_len; INT cmsg_level; INT cmsg_type; } + INT, 8-aligned.
    hdr = struct.calcsize("Qii")
    cmsg = struct.pack("Qii", hdr + 4, IPPROTO_IP, IP_TOS) + struct.pack("i", dscp << 2) + b"\0" * 4
    cbuf = ctypes.create_string_buffer(cmsg, len(cmsg))
    errors = 0
    first_error = 0
    for _ in range(count):
        msg = WSAMSG(ctypes.cast(ctypes.pointer(sa), ctypes.c_void_p), ctypes.sizeof(sa),
                     ctypes.pointer(wbuf), 1, WSABUF(len(cmsg), ctypes.cast(cbuf, ctypes.c_void_p)), 0)
        sent = wt.DWORD()
        if send_msg(s.fileno(), ctypes.byref(msg), 0, ctypes.byref(sent), None, None) != 0:
            errors += 1
            first_error = first_error or ctypes.get_last_error()
        time.sleep(0.01)
    s.close()
    return "WSASendMsg: %d of %d failed%s" % (errors, count, " (error %d)" % first_error if errors else "")


def method_toggle(ip, port, dscp, count):
    """One socket, the value changed before every packet, as libjuice does when
    audio (EF), video and SCTP interleave: 311 EF, 313 AF41, 315 AF11, 317 0."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    plan = ((46, 311, b"e"), (34, 313, b"a"), (10, 315, b"d"), (0, 317, b"z"))
    failed = 0
    for _ in range(count):
        for value, size, tag in plan:
            try:
                s.setsockopt(IPPROTO_IP, IP_TOS, value << 2)
            except OSError:
                failed += 1
            s.sendto((tag * size)[:size], (ip, port))
        time.sleep(0.01)
    s.close()
    return "4 values in turn, %d setsockopt failed" % failed


IPPROTO_IPV6 = 41
IPV6_V6ONLY = 27
IPV6_TCLASS = 39


def method_dual(which):
    """libjuice's own socket: IPv6, dual stack (IPV6_V6ONLY off), reaching an
    IPv4 peer through its v4-mapped address. Which option marks that traffic:
    319 IPV6_TCLASS alone, 321 IP_TOS alone, 323 both."""
    size = {"tclass": 319, "tos": 321, "both": 323}[which]

    def run(ip, port, dscp, count):
        s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        s.setsockopt(IPPROTO_IPV6, IPV6_V6ONLY, 0)
        notes = []
        if which in ("tclass", "both"):
            try:
                s.setsockopt(IPPROTO_IPV6, IPV6_TCLASS, dscp << 2)
                notes.append("IPV6_TCLASS ok")
            except OSError as e:
                notes.append("IPV6_TCLASS failed: %s" % e)
        if which in ("tos", "both"):
            try:
                s.setsockopt(IPPROTO_IP, IP_TOS, dscp << 2)
                notes.append("IP_TOS ok")
            except OSError as e:
                notes.append("IP_TOS failed: %s" % e)
        payload = (b"6" * size)[:size]
        for _ in range(count):
            s.sendto(payload, ("::ffff:" + ip, port))
            time.sleep(0.01)
        s.close()
        return ", ".join(notes)

    return run


def qos_flow(s, ip, port):
    if not qwave:
        return None, None, "no qwave.dll"
    handle = wt.HANDLE()
    ver = QOS_VERSION(1, 0)
    if not qwave.QOSCreateHandle(ctypes.byref(ver), ctypes.byref(handle)):
        return None, None, "QOSCreateHandle failed (%d)" % ctypes.get_last_error()
    sa = sockaddr(ip, port)
    flow = wt.DWORD(0)
    if not qwave.QOSAddSocketToFlow(handle, ctypes.c_size_t(s.fileno()), ctypes.byref(sa),
                                    QOSTrafficTypeVoice, QOS_NON_ADAPTIVE_FLOW, ctypes.byref(flow)):
        return handle, None, "QOSAddSocketToFlow failed (%d)" % ctypes.get_last_error()
    return handle, flow, "flow %d (Voice)" % flow.value


def method_qwave_type(ip, port, dscp, count):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    handle, flow, note = qos_flow(s, ip, port)
    send_n(s, ip, port, 307, count, b"Q")
    if handle:
        qwave.QOSCloseHandle(handle)
    s.close()
    return note


def method_qwave_value(ip, port, dscp, count):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    handle, flow, note = qos_flow(s, ip, port)
    if flow is not None:
        value = wt.DWORD(dscp)
        ok = qwave.QOSSetFlow(handle, flow, QOSSetOutgoingDSCPValue, ctypes.sizeof(value),
                              ctypes.byref(value), 0, None)
        note += "; QOSSetFlow(%d) %s" % (dscp, "ok" if ok else "failed (%d)" % ctypes.get_last_error())
    send_n(s, ip, port, 309, count, b"V")
    if handle:
        qwave.QOSCloseHandle(handle)
    s.close()
    return note


def main():
    ip = sys.argv[1]
    dscp = int(sys.argv[2]) if len(sys.argv) > 2 else 46
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 9
    admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
    print("to %s:%d, DSCP %d asked, %d packets each, admin=%s" % (ip, port, dscp, count, admin))
    for name, fn in (("plain 301", method_plain), ("ip_tos 303", method_ip_tos), ("cmsg 305", method_cmsg),
                     ("qwave_type 307", method_qwave_type), ("qwave_value 309", method_qwave_value),
                     ("toggle 311-317", method_toggle), ("dual tclass 319", method_dual("tclass")),
                     ("dual tos 321", method_dual("tos")), ("dual both 323", method_dual("both"))):
        try:
            note = fn(ip, port, dscp, count)
        except Exception as e:  # noqa: BLE001 — a probe reports, it does not stop
            note = "raised %r" % e
        print("%-16s %s" % (name, note), flush=True)
        time.sleep(0.3)


if __name__ == "__main__":
    main()
