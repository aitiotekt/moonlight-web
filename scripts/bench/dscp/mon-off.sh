#!/bin/bash
# Back to managed, handed back to NetworkManager.
S() { sudo "$@"; }
S ip link set wlp3s0 down
S iw dev wlp3s0 set type managed
S ip link set wlp3s0 up
S nmcli dev set wlp3s0 managed yes
sleep 2
iw dev wlp3s0 info | grep -E "type|ifindex"
nmcli -t -f DEVICE,TYPE,STATE dev | grep wlp3s0
