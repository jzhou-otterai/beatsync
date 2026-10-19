# Beatsync Speaker (macOS)

Turns a Beatsync room into an external speaker for your Mac. It adds a virtual audio output device
called **Beatsync**. Anything you play to it (Spotify, YouTube, a game) is streamed into the room,
and every phone or laptop there plays it in sync. Your Mac's own speakers aren't touched, the same
way choosing AirPlay doesn't mute them.

It uses the same connection as the web app: it joins a room over the server's `/ws` WebSocket,
keeps a server clock estimate with the same NTP probe-pair exchange, and the server relays its
audio to the room. Each audio frame is stamped with the server time it should play at, so
receivers schedule it the same way they schedule synchronized play/pause.

## Requirements

- macOS 13 or later
- A Beatsync server built from this repo. The live-stream messages are new, so a stock server
  (including beatsync.gg) won't relay them.
- Xcode command line tools, to build the driver and capture helper

## Run it

```bash
bun install                 # from the repo root
bun dev                     # server on :8080, web client on :3000
bun run desktop             # builds the driver + helper and launches the app
```

If port 8080 is already taken (`bun dev` prints `EADDRINUSE`), run the server on another port.
Put `PORT=8090` in `apps/server/.env`, point the web client at it in `apps/client/.env.local`
(`NEXT_PUBLIC_API_URL=http://localhost:8090`, `NEXT_PUBLIC_WS_URL=ws://localhost:8090/ws`), and set
the app's **Advanced → Server WebSocket URL** to `ws://localhost:8090/ws`.

In the app, enter a room code and click **Start streaming**. The first time:

1. **The Beatsync audio device installs itself.** The driver ships inside the app. macOS asks for
   your password, because the driver goes into `/Library/Audio/Plug-Ins/HAL`. The app then
   restarts Core Audio so "Beatsync" shows up. Newer app versions reinstall the driver the same way
   when it changes.
2. **macOS asks for Microphone access.** Reading the Beatsync device counts as audio input, and
   without access macOS hands the app silence. You can change this later in System Settings →
   Privacy & Security → Microphone.

With **Switch this Mac's output to Beatsync while streaming** on (the default), the app makes
Beatsync the Mac's output and switches back to your previous output when you stop. With it off,
choose Beatsync yourself, either system-wide in Sound settings or just in one app's output menu.

**Volume.** The Beatsync device has its own volume and mute controls, so the Mac's volume keys
and the Sound menu slider work while it's the output. They set how loud **this Mac** plays, and
they don't change the room. Beatsync's volume drives the speakers' own hardware volume, so the
keys have the Mac's native range and curve. Streaming starts at the speakers' current level, and
they keep your last setting when you stop. Listeners always get full-level audio and set their own volume on their
device or with the room's volume slider.

**Room volume.** The slider under the stream status sets the volume on every device in the room,
this Mac included. It's the same room-wide volume as the web app's slider, so the two stay in sync.
Changing it needs playback control in the room (admin, or a room open to everyone). The Mac's own
volume keys then work on top of it, for the Mac only.

Open the same room on your other devices and click **Start System**. Instead of the track
player, they show a "Live from …" banner. On a home network, **Copy LAN join link** puts a link
like `http://192.168.1.20:3000/room/123456` on the clipboard. It swaps `localhost` in the web app
URL for the Mac's Wi-Fi address. With the dev setup, the web client does the same for its server
URL, so phones reach the server on the Mac too. The first time another device connects, macOS may
ask whether `bun`/`node` can accept incoming connections.

To remove the device:

```bash
sudo rm -rf /Library/Audio/Plug-Ins/HAL/Beatsync.driver && sudo killall coreaudiod
```

**Menu bar.** The app also lives in the menu bar (the ring icon, filled while you're live).
Click it for a small widget showing the stream status, a level meter, Room volume and
Start/Stop. Right-click for Open / Quit. Closing the main window keeps the app running there.

## Install (DMG)

```bash
cd apps/desktop && bun run dist      # → release/Beatsync Speaker-<version>-universal.dmg
```

Open the DMG and drag **Beatsync Speaker** into Applications. That's the whole install: the
capture helper and the Beatsync audio driver ship inside the app, and the driver installs
itself the first time you start streaming. The DMG is universal (Apple Silicon and Intel).

**Signing.** Without an Apple Developer ID, the build is ad-hoc signed. It runs fine on the Mac
that built it. On other Macs, Gatekeeper blocks the first launch: open System Settings → Privacy &
Security and click **Open Anyway** (or run `xattr -dr com.apple.quarantine "/Applications/Beatsync Speaker.app"`).
To produce a build that opens without warnings, sign and notarize it with a Developer ID:

```bash
CSC_NAME="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=TEAMID \
bun run dist --config.mac.notarize=true
```

The app icon and menu bar icons are generated from `resources/*.svg` by
`scripts/build-icons.sh`. Re-run it after editing the artwork.

## How it works

```
apps ──► "Beatsync" output device (driver/BeatsyncDriver.c, runs in coreaudiod)
            │ loopback: output → ring buffer → input
            ▼
         beatsync-audio-capture (Swift) reads the device's input
            │ s16le PCM on stdout
            ▼
         Electron main process
           PcmChunker: 960-frame chunks, each stamped
           playAt = serverNow + buffer (advanced by sample count)
            │ binary WebSocket frames
            ▼
         Beatsync server: relays frames from the room's broadcaster
            │
            ▼
         Web clients: LiveStreamPlayer schedules each frame at
         playAt − clock offset − output latency, back to back,
         nudging playbackRate (±0.3%) to absorb clock drift
```

- **`driver/BeatsyncDriver.c`**: an AudioServerPlugIn (Core Audio HAL plug-in) with one stereo
  float32 device at 44.1 or 48 kHz. It has master volume and mute controls, saved across restarts in
  Core Audio's storage. They're *not* applied to the loopback. Its clock runs off the host clock. Output written by apps goes
  into a ring buffer by sample time and comes back out of the device's input stream. Reads past
  the last write return silence, so stale audio never replays. It never becomes the default input
  or the alert-sound device. `CFBundleVersion` in `driver/Info.plist` decides when the app
  reinstalls it, so bump it whenever the driver changes.
- **`src/driverInstall.ts`**: installs the bundled driver through macOS's administrator prompt
  (`osascript … with administrator privileges`). The app never sees the password.
- **`native/DeviceCapture.swift`**: finds the device by UID, checks Microphone permission up front,
  and streams the input as PCM. With `--route`, it makes Beatsync the default output and restores the
  previous one on exit. With `--monitor`, it plays a delayed copy on the Mac's original output and
  scales just that copy by the Beatsync device's volume/mute. `beatsync-audio-capture probe` reports install and permission state.
- **`src/broadcaster.ts`**: the room client (WebSocket, NTP, `START_LIVE_STREAM`/`STOP_LIVE_STREAM`, liveness).
- **`src/pcmChunker.ts`**: frames and timestamps. It re-anchors if the device clock drifts more than
  25 ms from the server clock, and after sleep/wake.
- **`packages/shared/liveStream.ts`**: the binary frame format shared by all three apps.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Switch this Mac's output to Beatsync while streaming | on | Off: pick Beatsync yourself, system-wide or per app |
| Buffer | 400 ms | Delay between playing on the Mac and hearing it in the room. Raise it if devices stutter on a busy network |
| Server WebSocket URL | `ws://localhost:8080/ws` | Your self-hosted server |
| Web app URL | `http://localhost:3000` | Used by "Open room in browser" and the LAN link |

Only someone who can control playback can start a live stream: an admin, or anyone if the room
allows everyone. The first client in a room is admin, so starting the Mac first in an empty room
always works.

## Limitations

- Audio is uncompressed 16-bit PCM, about 1.5 Mbit/s per listener. That's fine on a LAN, but heavy
  over the internet. Opus via WebCodecs would cut it by about 10×.
- The macOS menu bar shows the orange microphone indicator while streaming, because the app reads
  an input device.
- Neither the app nor the driver is code-signed. On another Mac, right-click → Open the app the
  first time.
