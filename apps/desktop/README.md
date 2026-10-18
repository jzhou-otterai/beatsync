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

To build a distributable `.dmg` (universal, unsigned; the driver is bundled under
`Contents/Resources/driver`):

```bash
cd apps/desktop && bun run dist      # output in apps/desktop/release/
```

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
  float32 device at 44.1 or 48 kHz. Its clock runs off the host clock. Output written by apps goes
  into a ring buffer by sample time and comes back out of the device's input stream. Reads past
  the last write return silence, so stale audio never replays. It never becomes the default input
  or the alert-sound device. `CFBundleVersion` in `driver/Info.plist` decides when the app
  reinstalls it, so bump it whenever the driver changes.
- **`src/driverInstall.ts`**: installs the bundled driver through macOS's administrator prompt
  (`osascript … with administrator privileges`). The app never sees the password.
- **`native/DeviceCapture.swift`**: finds the device by UID, checks Microphone permission up front,
  and streams the input as PCM. With `--route`, it makes Beatsync the default output and restores the
  previous one on exit. `beatsync-audio-capture probe` reports install and permission state.
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

- The Beatsync device has no volume control, so the Mac's volume keys don't affect it. Use the room's
  volume slider instead.
- Audio is uncompressed 16-bit PCM, about 1.5 Mbit/s per listener. That's fine on a LAN, but heavy
  over the internet. Opus via WebCodecs would cut it by about 10×.
- The macOS menu bar shows the orange microphone indicator while streaming, because the app reads
  an input device.
- Neither the app nor the driver is code-signed. On another Mac, right-click → Open the app the
  first time.
