# Beatsync Speaker (macOS)

A desktop app that makes every device in a Beatsync room act as an external speaker for your Mac.
Whatever the Mac is playing (Spotify, YouTube, a game, system sounds) is captured and streamed
into the room, and each phone or laptop plays it in sync.

It uses the same connection as the web app: it joins a room over the server's `/ws` WebSocket,
keeps a server clock estimate with the same NTP probe-pair exchange, and the server relays its
audio to the room. Each audio frame is stamped with the server time it should play at, so
receivers schedule it the same way they schedule synchronized play/pause.

## Requirements

- macOS 14.2 or later (Core Audio process taps)
- A Beatsync server built from this repo. The live-stream messages are new, so a stock server
  (including beatsync.gg) won't relay them.
- Xcode command line tools, to build the native capture helper

## Run it

```bash
bun install                 # from the repo root
bun dev                     # server on :8080, web client on :3000
bun run desktop             # builds the helper and launches the app
```

In the app, enter a room code and click **Start streaming**. The first time you do this, macOS asks to
let the app record system audio. Allow it, then stop and start the stream again. You can change this later in
System Settings → Privacy & Security → Screen & System Audio Recording.

Open the same room on your other devices and click **Start System**. Instead of the track player,
they show a "Live from …" banner.

To build a distributable `.dmg` (universal, unsigned):

```bash
cd apps/desktop && bun run dist      # output in apps/desktop/release/
```

## How it works

```
macOS audio ──► beatsync-audio-tap (Swift, Core Audio process tap)
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

- **`native/SystemAudioTap.swift`**: creates a global stereo process tap inside a private aggregate
  device and writes PCM to stdout. It reports the aggregate's actual sample rate (usually the output
  device's rate, e.g. 44.1 kHz on MacBook speakers, not the tap's nominal 48 kHz). With `--mute`,
  it silences the Mac's own output while it captures.
- **`src/broadcaster.ts`**: the room client (WebSocket, NTP, `START_LIVE_STREAM`/`STOP_LIVE_STREAM`, liveness).
- **`src/pcmChunker.ts`**: frames and timestamps. It re-anchors if the Mac's audio clock drifts more
  than 25 ms from the server clock, and after sleep/wake.
- **`packages/shared/liveStream.ts`**: the binary frame format shared by all three apps.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Mute this Mac while streaming | on | Otherwise the Mac plays the audio *before* the room does (by the buffer length) |
| Buffer | 400 ms | Delay between the Mac and the speakers. Raise it if devices stutter on a busy network. Video on the Mac will be this far ahead of the sound |
| Server WebSocket URL | `ws://localhost:8080/ws` | Your self-hosted server |
| Web app URL | `http://localhost:3000` | Used by "Open room in browser" |

Only someone who can control playback can start a live stream: an admin, or anyone if the room
allows everyone. The first client in a room is admin, so starting the Mac first in an empty room
always works.

## Limitations

- Audio is uncompressed 16-bit PCM, about 1.4 Mbit/s per listener at 44.1 kHz. That's fine on a LAN,
  but heavy over the internet. Opus via WebCodecs would cut it by about 10×.
- Don't open the room as a listener on the broadcasting Mac itself. Its output would be captured again.
- The app isn't code-signed. On another Mac, right-click → Open the first time.
