#!/usr/bin/env bash
# Builds the universal (arm64 + x86_64) system-audio tap helper into bin/
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping native helper build (macOS only)"
  exit 0
fi

mkdir -p bin
SRC=native/SystemAudioTap.swift
xcrun swiftc -O -target arm64-apple-macos14.2 "$SRC" -o bin/beatsync-audio-tap-arm64
xcrun swiftc -O -target x86_64-apple-macos14.2 "$SRC" -o bin/beatsync-audio-tap-x86_64
lipo -create bin/beatsync-audio-tap-arm64 bin/beatsync-audio-tap-x86_64 -output bin/beatsync-audio-tap
rm bin/beatsync-audio-tap-arm64 bin/beatsync-audio-tap-x86_64
echo "Built bin/beatsync-audio-tap"
