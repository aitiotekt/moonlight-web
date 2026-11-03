#!/bin/bash
# usage: mon-cap.sh <seconds> <out.pcap>
S() { sudo "$@"; }
S timeout "$1" tcpdump -i wlp3s0 -s 96 -w "$2" 2>&1 | tail -3
S chmod a+r "$2"
