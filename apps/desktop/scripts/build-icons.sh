#!/usr/bin/env bash
# Regenerates the app icon (resources/icon.icns) and menu bar icons from the SVGs in
# resources/. Uses headless Google Chrome to rasterize; the outputs are committed, so
# this only needs to run when the artwork changes.
set -euo pipefail
cd "$(dirname "$0")/../resources"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

render() { # svg size out.png
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --user-data-dir="$TMP/profile" --window-size="$2,$2" --screenshot="$3" "file://$PWD/$1" >/dev/null 2>&1
}

# App icon: every size in the macOS iconset
render icon.svg 1024 "$TMP/icon-1024.png"
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$TMP/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$TMP/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o icon.icns
cp "$TMP/icon-1024.png" icon.png

# Menu bar: 18pt template images (@1x and @2x)
for name in tray tray-live; do
  out="$(echo "$name" | sed 's/-live/Live/')Template"
  render "$name.svg" 36 "$TMP/$name.png"
  cp "$TMP/$name.png" "$out@2x.png"
  sips -z 18 18 "$TMP/$name.png" --out "$out.png" >/dev/null
done
echo "Icons written to resources/"
