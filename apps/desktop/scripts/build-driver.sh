#!/usr/bin/env bash
# Builds the Beatsync virtual audio device (a Core Audio HAL plug-in) into build/Beatsync.driver
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping driver build (macOS only)"
  exit 0
fi

OUT=build/Beatsync.driver
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"
cp driver/Info.plist "$OUT/Contents/Info.plist"

for ARCH in arm64 x86_64; do
  xcrun clang -bundle -O2 -Wall -Wextra -Werror -arch "$ARCH" -mmacosx-version-min=12.0 \
    -framework CoreAudio -framework CoreFoundation \
    driver/BeatsyncDriver.c -o "build/Beatsync-$ARCH"
done
lipo -create build/Beatsync-arm64 build/Beatsync-x86_64 -output "$OUT/Contents/MacOS/Beatsync"
rm build/Beatsync-arm64 build/Beatsync-x86_64

# coreaudiod only loads signed plug-ins; ad hoc is enough for a local install
codesign --force --sign - "$OUT"
echo "Built $OUT"
