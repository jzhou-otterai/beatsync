#!/usr/bin/env bash
# Builds the DMG. Signs with a Developer ID only when one is named explicitly
# (CSC_NAME or CSC_LINK); otherwise electron-builder would pick up any signing
# certificate in the keychain — e.g. an "Apple Development" one, which isn't valid
# for distribution and makes codesign stop for a keychain prompt. Without one, the
# afterPack hook ad-hoc signs the app.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${CSC_NAME:-}" && -z "${CSC_LINK:-}" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi
exec electron-builder --mac --publish never "$@"
