#!/usr/bin/env bash
# MoonlightWeb — write the edition's AppStream metadata from the template.
#
# Usage: make-metainfo.sh <APP> <NAME> <version> <out.xml> [launchable desktop id]
#
# Shared by make-packages.sh (the .deb and the .rpm, whose menu entry is named
# after the component ID) and the AppImage step of release.yml (whose menu
# entry is "<APP>.desktop", so it passes that as the launchable). The AppImage
# catalog takes the default screenshot from this file for the app's page.
set -euo pipefail

APP=$1
NAME=$2
VERSION=$3
OUT=$4
APPID=top.moonlightweb.$APP
LAUNCHABLE=${5:-$APPID.desktop}

sed -e "s/@MW_VERSION@/$VERSION/g" -e "s/@MW_DATE@/$(date -u +%Y-%m-%d)/g" \
    -e "s/top\.moonlightweb\.MoonlightWeb/$APPID/g" \
    -e "s|<launchable type=\"desktop-id\">[^<]*</launchable>|<launchable type=\"desktop-id\">$LAUNCHABLE</launchable>|" \
    -e "s|^  <name>MoonlightWeb</name>|  <name>$APP</name>|" \
    -e "s|<binary>moonlightweb</binary>|<binary>$NAME</binary>|" \
    "$(dirname "$0")/top.moonlightweb.MoonlightWeb.metainfo.xml" > "$OUT"

# Catches a malformed template before it reaches a user's software centre.
# Advisory only: appstreamcli is not installed on every build host, and its
# newer releases add warnings that would otherwise break packaging.
if command -v appstreamcli >/dev/null 2>&1; then
    appstreamcli validate --no-net "$OUT" \
        || echo "warning: AppStream validation reported issues (not fatal)"
fi
