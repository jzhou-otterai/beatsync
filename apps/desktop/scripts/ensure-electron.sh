#!/usr/bin/env bash
# Bun skips dependency lifecycle scripts by default, so Electron's postinstall
# (which downloads the Electron binary) may not have run. Run it on demand
# rather than trusting it repo-wide, which would also download Electron during
# server/client installs.
set -euo pipefail
cd "$(dirname "$0")/.."
ELECTRON_DIR="$(dirname "$(node -p "require.resolve('electron/package.json')")")"
if [[ ! -f "$ELECTRON_DIR/path.txt" ]]; then
  echo "Downloading Electron binary..."
  node "$ELECTRON_DIR/install.js"
fi

