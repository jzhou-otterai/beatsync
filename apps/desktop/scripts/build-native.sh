#!/usr/bin/env bash
# Builds the universal (arm64 + x86_64) capture helper into bin/ and the virtual
# audio device into build/
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping native build (macOS only)"
  exit 0
fi

mkdir -p bin
SRC=native/DeviceCapture.swift
for ARCH in arm64 x86_64; do
  xcrun swiftc -O -target "$ARCH-apple-macos13.0" "$SRC" -o "bin/beatsync-audio-capture-$ARCH"
done
lipo -create bin/beatsync-audio-capture-arm64 bin/beatsync-audio-capture-x86_64 -output bin/beatsync-audio-capture
rm bin/beatsync-audio-capture-arm64 bin/beatsync-audio-capture-x86_64
rm -f bin/beatsync-audio-tap
echo "Built bin/beatsync-audio-capture"

bash scripts/build-driver.sh
