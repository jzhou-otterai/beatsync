#!/usr/bin/env bash
# Builds the room the app hosts itself: the Beatsync server as a universal (arm64 +
# x86_64) standalone executable in bin/, and a static export of the web client in
# build/web, which that server serves from the same port as its API and WebSocket
set -euo pipefail
cd "$(dirname "$0")/.."
DESKTOP="$PWD"
ROOT="$DESKTOP/../.."

mkdir -p bin build
SERVER_OUT="$DESKTOP/bin/beatsync-server"
for ARCH in arm64 x64; do
  # No .env autoloading: the bundled server must not pick up a developer's S3 keys
  (cd "$ROOT/apps/server" && bun build src/index.ts --compile --minify --no-compile-autoload-dotenv \
    --target="bun-darwin-$ARCH" --outfile "$SERVER_OUT-$ARCH")
done
lipo -create "$SERVER_OUT-arm64" "$SERVER_OUT-x64" -output "$SERVER_OUT"
rm "$SERVER_OUT-arm64" "$SERVER_OUT-x64"
# lipo invalidates each slice's ad-hoc signature, and Apple Silicon won't run unsigned code
codesign --force --sign - "$SERVER_OUT"
echo "Built bin/beatsync-server"

# Empty API/WS URLs override apps/client/.env*: the export derives them from the page's
# own origin (apps/client/src/lib/urls.ts). No analytics from a LAN-only copy. Listeners
# start playing as soon as they open the link, without a "Start System" click.
(cd "$ROOT/apps/client" && rm -rf out && BEATSYNC_STATIC_EXPORT=1 NEXT_PUBLIC_AUTO_START=1 \
  NEXT_PUBLIC_API_URL= NEXT_PUBLIC_WS_URL= NEXT_PUBLIC_POSTHOG_KEY= bunx next build)
rm -rf build/web
cp -R "$ROOT/apps/client/out" build/web
echo "Built build/web"
