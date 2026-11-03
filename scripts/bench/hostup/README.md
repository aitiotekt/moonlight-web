# The host's own upload against the stream — the bench's probes

Plan « le stream passe avant un gros envoi du PC hôte » (24/10/2026). On the
evening of 24/10, the stream from DualRTX to a Wi-Fi client froze for 2 to
27 s whenever TeraBox uploaded 40-125 Mbit/s from DualRTX itself, although
every packet of the stream already left marked AF41. A ping from DualRTX to
the box, without any stream, rose to 240-746 ms (median 13 ms, ~1 ms on a
cable). The first question is where that queue sits. The second is whether
capping the host's other uploads, below what the path carries, keeps it empty.

No new executable, nothing that listens, no elevation, except `hostup_cap.ps1
-On/-Off/-Show`, which is a system change for a trial with Bruno only.

## Tools

| File | What |
|---|---|
| `hostup_probe.ps1` | timestamped ICMP pings to several targets at once (one runspace each, 200 ms), and the adapter's byte counters once a second, into one folder; `-Mark <phase>` opens a phase |
| `tcp_rtt.py` | a marked "ping" without administrator rights: TCP handshake times to an open port, the classes taking turns (DF, AF41, ...) |
| `udp_rtt.py` | a UDP "ping" without administrator rights: DNS round trips to the box on four sockets in turn (IPv4 opened at start, dual-stack like libjuice's, the same with AF41, a fresh one each query), fixed local ports 49951-49953 |
| `hostup_report.py` | one table per phase: each path's median / p95 / max and losses, the host's upload, and the worker logs' freezes |
| `hostup_cap.ps1` | the hand-made cap of trial S0: two ActiveStore QoS policies (all TCP and UDP capped, the MoonlightWeb executable exempt), `-Off`, `-Show`, `-DryRun` |

## Where the queue is (phase M)

```
$d = "<scratchpad>\m1"
.\hostup_probe.ps1 -OutDir $d -Seconds 1200 `
    -Target box=192.168.1.254,repeater=<its wired IP>,um=<UM790Pro>,m3=<the client>
python tcp_rtt.py 192.168.1.254 --port 80 --classes DF,AF41 --out $d\tcp-box.csv --stop $d\stop
.\hostup_probe.ps1 -OutDir $d -Mark a-paused        # each time the upload is paused or resumed
...
New-Item $d\stop                                    # ends both
python hostup_report.py $d --log <worker log>
```

What each path tells:

| Path from the host | crosses | bad while the host uploads means |
|---|---|---|
| a machine on the same switch | the host's NIC and vSwitch, the switch | the queue is in the host itself |
| the repeater's own address | the cable to the repeater | its Ethernet side |
| the box | the repeaters' Wi-Fi link | the repeater's radio toward the box |
| a Wi-Fi client of the repeater | the repeater's radio toward its clients | what the stream feels |
| `tcp_rtt.py` AF41 against DF, to the box | the same link, marked | equal = the queue ignores the mark |

The repeater's address: its MAC is in `freebox-api-rates` (38:07:16:BD:16:37
for the 2nd floor), its IP in the Freebox app or `fbx.py hosts`.

## The cap (trial S0, with Bruno's go only)

```
# an elevated PowerShell, typed by Bruno
.\hostup_cap.ps1 -On -Mbps 50 -Exe E:\Code\moonlight-web\build\MoonlightWeb.exe
.\hostup_cap.ps1 -Off
.\hostup_cap.ps1 -Show      # must end with "none of ours"
```

Microsoft's precedence rules say the executable's own policy (DSCP only)
wins for the stream and the catch-all cap takes everything else. Measured on
25/10/2026, it does not: with the executable named by its path, by its name
alone, and against a `-Catch Default` cap, the adapter stayed flat at the cap
with the stream inside it, and the stream froze for 4 to 52 s. The cap itself
works: under 50 Mbit/s the repeater's queue empties (the box at 3-4 ms). What
the cap does not exempt waits in Windows' own pacer (0.2-1.2 s for a TCP
handshake). The bench's S1 bis (25/10, `udp_rtt.py` and `tcp_rtt.py` from
python.exe as the stand-in) found why: at equal precedence (127) Windows
applies the cap, not the policy naming the application, even with a throttle
of its own on it. `-Precedence 255` on the application's policy exempts all it
sends (3 ms against 250-370 ms for the rest); so does a policy on the local
UDP port. `hostup_cap.ps1` does not set the precedence yet.

A PowerShell typed by Bruno through a stream must be in the production
instance: a `--dev` worker runs on his plain token and cannot type into an
elevated window.

The same thing from the native host itself is the bench key
`hostcap=<Mbit/s>` (`native_tuning` or `MW_NATIVE_TUNING`; trial S2). The
worker sets "MoonlightWeb stream <pid>" and "MoonlightWeb host cap <pid>"
when the channels open, and a detached PowerShell removes them when the
session ends. Only a worker with administrator rights can set them: the one
the launcher service starts as SYSTEM (the DEV edition installed), not a
`--dev` on the user's plain token. Its log lines start with `[HostCap]`
(25/10: set 0.75 s after the channels open, removed ~1 s after the quit; a
`--dev` worker says « no administrator rights … nothing capped »). Since
`1fd17e89` the stream's policy has `-Precedence 255`, and the stream is
exempt: S3 on 25/10, the M3 over the cap, the box's queue at 5 ms. To
check by hand that nothing is left, use `hostup_cap.ps1 -Show` (elevated):
the next worker would sweep anything left behind.

What the relay logs all along (`35d616d2`): `[HostUpload]` while the host
sends more than max(8 Mbit/s, 20 % of the stream) besides it, and every
`[LinkFreeze]` line ends with what it sent around the freeze.
`hostup_report.py --log` counts both by phase. The QoS Packet Scheduler must be bound to the
adapter the stream leaves by (`Get-NetAdapterBinding -ComponentID ms_pacer`;
on DualRTX it is, on `vEthernet (LAN)`). A Hyper-V VM leaves by the physical
adapter and is not capped.
