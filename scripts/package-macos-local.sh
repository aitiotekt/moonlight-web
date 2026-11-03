#!/bin/bash
# Package an already-built fork without modifying an installed application.
# Usage: SIGN_IDENTITY='Developer ID Application: ...' scripts/package-macos-local.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${BUILD_DIR:-$ROOT/build}"
VERSION="${VERSION:-$(sed -n 's/^MW_VERSION:STRING=//p' "$BUILD/CMakeCache.txt")}"
REV="$(git -C "$ROOT" rev-parse --short=8 upstream/main)"
OUT="${OUTPUT_DIR:-$ROOT/dist-arm64/moonlightweb-$VERSION-fork-$REV}"
IDENTITY="${SIGN_IDENTITY:--}"
APP="$OUT/MoonlightWeb.app"
export APP VERSION

[ "$(uname -m)" = arm64 ] || { echo 'This package targets macOS arm64' >&2; exit 1; }
[ -n "$VERSION" ] && [ -x "$BUILD/MoonlightWeb" ]
[ ! -e "$OUT" ] || { echo "Output already exists: $OUT" >&2; exit 1; }
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/MoonlightWeb" "$APP/Contents/MacOS/MoonlightWeb"
cmake --install "$BUILD" --prefix "$OUT/stage" --component app
cp -R "$OUT/stage/frontend" "$APP/Contents/Resources/frontend"

ICONSET="$OUT/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256; do
    sips -z "$size" "$size" "$ROOT/frontend/assets/icon-512.png" \
        --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$ROOT/frontend/assets/icon-512.png" \
        --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$ROOT/frontend/assets/icon-512.png" "$ICONSET/icon_512x512.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/MoonlightWeb.icns"
python3 - <<'PY'
import os, plistlib
from pathlib import Path
app = Path(os.environ['APP'])
plist = dict(CFBundleExecutable='MoonlightWeb', CFBundleIdentifier='com.moonlightweb.server',
             CFBundleName='MoonlightWeb', CFBundlePackageType='APPL',
             CFBundleIconFile='MoonlightWeb', NSHighResolutionCapable=True,
             CFBundleShortVersionString=os.environ['VERSION'], CFBundleVersion=os.environ['VERSION'])
with (app / 'Contents/Info.plist').open('wb') as f:
    plistlib.dump(plist, f)
PY
QT_EXTRA_LIB_DIR="${QT_EXTRA_LIB_DIR:-/opt/homebrew/lib}"
if [ -d "$QT_EXTRA_LIB_DIR" ]; then
    macdeployqt "$APP" -libpath="$QT_EXTRA_LIB_DIR" -no-codesign
else
    macdeployqt "$APP" -no-codesign
fi
# Derive the real minimum from ALL shipped Mach-O files, including Homebrew's
# OpenSSL. Claiming the official package's minimum would be misleading here.
python3 - <<'PY'
import os, plistlib, re, subprocess
from pathlib import Path
app = Path(os.environ['APP'])
minimum = (12, 0)
for path in (app / 'Contents').rglob('*'):
    if not path.is_file() or path.is_symlink():
        continue
    kind = subprocess.check_output(['file', '-b', str(path)], text=True)
    if 'Mach-O' not in kind:
        continue
    headers = subprocess.check_output(['otool', '-l', str(path)], text=True)
    for command in re.split(r'Load command \d+\n', headers):
        if not re.search(r'\bcmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b', command):
            continue
        for version in re.findall(r'^\s+(?:minos|version) (\d+(?:\.\d+)+)', command, re.M):
            minimum = max(minimum, tuple(map(int, version.split('.'))))
    deps = subprocess.check_output(['otool', '-L', str(path)], text=True).splitlines()[1:]
    identity = subprocess.run(['otool', '-D', str(path)], text=True, capture_output=True).stdout.splitlines()[1:]
    for dep in deps:
        dep = dep.strip().split(' (', 1)[0]
        if dep in identity:
            continue  # A dylib's own install name is not an imported dependency.
        if dep.startswith('/') and not dep.startswith(('/System/Library/', '/usr/lib/')):
            raise SystemExit(f'Non-relocatable dependency: {path}: {dep}')
plistpath = app / 'Contents/Info.plist'
with plistpath.open('rb') as f:
    plist = plistlib.load(f)
plist['LSMinimumSystemVersion'] = '.'.join(map(str, minimum))
with plistpath.open('wb') as f:
    plistlib.dump(plist, f)
print('Minimum macOS:', plist['LSMinimumSystemVersion'])
PY

while IFS= read -r -d '' code; do
    codesign --force --timestamp=none -s "$IDENTITY" "$code"
done < <(find "$APP/Contents/Frameworks" \( -name '*.dylib' -o -name '*.framework' \) -print0)
while IFS= read -r -d '' code; do
    codesign --force --timestamp=none -s "$IDENTITY" "$code"
done < <(find "$APP/Contents/PlugIns" -name '*.dylib' -print0)
codesign --force --timestamp=none -s "$IDENTITY" --identifier com.moonlightweb.server \
    "$APP/Contents/MacOS/MoonlightWeb"
codesign --force --timestamp=none -s "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

APP="$APP" VERSION="$VERSION" OUT="$OUT/moonlightweb-$VERSION-fork-macos-arm64.pkg" \
    bash "$ROOT/backend/installer/macos/build-pkg.sh"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/MoonlightWeb-$VERSION-fork-macos-arm64.zip"
git -C "$ROOT" rev-parse HEAD upstream/main v0.4.1 > "$OUT/SOURCE_REVISIONS"
(
    cd "$OUT"
    shasum -a 256 ./*.pkg ./*.zip > SHA256SUMS
)
echo "Packages: $OUT"
