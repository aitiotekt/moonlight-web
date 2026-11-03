#!/bin/bash
# The access point's DSCP -> Wi-Fi queue table (D0.4), one BSSID per run, as root.
#
#   printf '%s\n' "<wifi key>" | sudo ./ap-table.sh <bssid> [ssid] [wifi-if] [wired-if]
#   MW_WIFI_PSK=<wifi key> sudo --preserve-env=MW_WIFI_PSK ./ap-table.sh <bssid>
#
# The Wi-Fi key comes from MW_WIFI_PSK, or else from stdin, and is never
# written anywhere: the NetworkManager profile lives in memory (save no), its
# secret is flagged "not saved" (psk-flags 2) and handed over through a pipe
# at activation. No IP on
# the Wi-Fi side (ap_table.py sends raw frames), so routes and DNS stay as
# they are. On exit, whatever happens, the profile is deleted and the
# interface is left managed and disconnected.
set -u
BSSID=$1
SSID=${2:-OctoPowerWifi7}
WIFI=${3:-wlp3s0}
WIRED=${4:-enp2s0}
CON=mw-ap-table
HERE=$(cd "$(dirname "$0")" && pwd)
PSK=${MW_WIFI_PSK:-}
unset MW_WIFI_PSK
[ -n "$PSK" ] || IFS= read -r PSK || { echo "no Wi-Fi key in MW_WIFI_PSK or on stdin" >&2; exit 2; }

cleanup() {
    nmcli connection down "$CON" >/dev/null 2>&1
    nmcli connection delete "$CON" >/dev/null 2>&1
    echo "# after: $(nmcli -t -f DEVICE,STATE device status | grep "^$WIFI:")," \
        "$(iw dev "$WIFI" info | awk '$1 == "type" {print "type " $2}')," \
        "profiles named $CON: $(nmcli -t -f NAME connection show | grep -c "^$CON\$")"
}
trap cleanup EXIT

nmcli connection delete "$CON" >/dev/null 2>&1
nmcli connection add save no type wifi ifname "$WIFI" con-name "$CON" autoconnect no \
    ssid "$SSID" 802-11-wireless.bssid "$BSSID" \
    802-11-wireless.cloned-mac-address permanent 802-11-wireless.powersave 2 \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk-flags 2 \
    ipv4.method disabled ipv6.method disabled >/dev/null || exit 1
nmcli --wait 45 connection up "$CON" \
    passwd-file <(printf '802-11-wireless-security.psk:%s\n' "$PSK") >/dev/null || exit 1
unset PSK
iw dev "$WIFI" link | grep -E 'Connected|SSID|freq|signal|bitrate'
python3 "$HERE/ap_table.py" --wifi "$WIFI" --wired "$WIRED"
