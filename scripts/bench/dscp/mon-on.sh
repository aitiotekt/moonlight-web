#!/bin/bash
# Monitor mode on the AX210 (wlp3s0), channel 44 / 80 MHz (centre 5210), passive.
S() { sudo "$@"; }
S nmcli dev set wlp3s0 managed no
S ip link set wlp3s0 down
S iw dev wlp3s0 set type monitor
S ip link set wlp3s0 up
S iw dev wlp3s0 set freq 5220 80 5210
iw dev wlp3s0 info
