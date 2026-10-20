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
- Nothing else to use it: the app hosts the room itself (see [Hosting the room](#hosting-the-room)).
  To use an external server instead, it has to be built from this repo. The live-stream messages
  are new, so a stock server (including beatsync.gg) won't relay them.
- To build it: Bun and the Xcode command line tools (for the driver and capture helper)

## Hosting the room

The app has the Beatsync server and web app built in. With **Advanced → Host the room on this
Mac** on (the default), starting a stream (or clicking **Copy LAN join link**) starts that server
on port 8095 (**Advanced → Port**). It serves the web app and the room's API and WebSocket from
that one port on every network interface. Phones on the same Wi-Fi only need the LAN join link,
e.g. `http://192.168.1.20:8095/room/123456`. The port never changes by itself, so a speaker can
reuse that link. An open page reconnects if the app hosts the room again within about two minutes;
after that, reload it. If another app holds the port, the app says so instead of moving to another
port, because existing links would then point at nothing. The link also contains the Mac's Wi-Fi
address. To keep that from changing, give the Mac a DHCP reservation on your router. No repo, no
`bun dev`. The first time a phone connects, macOS may ask whether Beatsync Speaker can accept
incoming connections. Allow it. The server stops when you quit the app.

The hosted server keeps rooms in memory and has no storage bucket, so uploading tracks doesn't
work in a hosted room. The live stream from the Mac does. Its log is at
`~/Library/Logs/Beatsync Speaker/server.log`.

Turn the option off to use an external server instead: the **Server WebSocket URL** and **Web
app URL** fields below it then apply, e.g. for `bun dev` while working on the server.

## Run it from source

```bash
bun install                 # from the repo root
bun run desktop             # builds the driver, helper, server and web app, then launches the app
```

That's enough on its own, because the app hosts the room. To develop against `bun dev` instead
(server on :8080, web client on :3000), turn off **Advanced → Host the room on this Mac**.
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

**Mac timing.** The Mac's copy is delayed by the buffer minus the speakers' reported output
latency, so it lands with the room on paper. Phones, especially over Bluetooth, often misreport
their own latency, so exact sync needs your ear. Use the **Mac timing** slider under "Also play on
this Mac" (±250 ms, applies live): slide right if the Mac sounds ahead of the phones, left if it's
behind. It's saved between sessions. Per-phone fine-tuning lives in the web app's nudge control.

**Room volume.** The slider under the stream status sets the volume on every _other_ device in
the room. It doesn't affect this Mac, which follows only its own volume keys, so 100% on Beatsync is
always your speakers' maximum. It's the same room-wide volume as the web app's slider, so the two stay in sync.
Changing it needs playback control in the room (admin, or a room open to everyone).

Open the same room on your other devices. In a room the app hosts, they start playing as soon
as their clock is synced. There's no **Start System** click. Browsers only allow audio after the
page gets a tap or key press, though (always on iPhone; on other browsers for a site that hasn't
played media before). Until then, the page shows "Tap anywhere to turn on sound". For a fully
hands-free speaker, such as a spare laptop, run Chrome with
`--autoplay-policy=no-user-gesture-required`. With an external server, listeners click **Start
System** as before. Instead of the track player, they show a "Live from …" banner. **Copy LAN join link** puts a link to the room on the
clipboard, with the Mac's Wi-Fi address in place of `localhost`. When hosting the room, the status
area shows that link too. With an external dev setup (`http://localhost:3000`), the web client
also swaps `localhost` in its server URL, so phones reach the server on the Mac.

**Bluetooth listeners.** Bluetooth headphones and speakers play everything a few hundred ms
late. This is handled automatically: the web app reads the delay the browser reports
(`AudioContext.outputLatency`, which covers Bluetooth on Safari 18.4+ and Chrome) and plays that
much earlier. To make room for it, the app grows the stream's buffer by the slowest listener's
delay: your buffer plus, say, 290 ms for a phone on a Bluetooth speaker. Without that, the frames
reach that device too late to play early, and it goes silent. The Mac's own speakers are delayed by the same amount, so
everything stays in step. The status area says when the buffer is raised. When those headphones
disconnect or the listener leaves, the buffer drops back to the one you set. Each change causes
one short gap while everyone moves to the new timing. Readings over 400 ms are treated as bogus
and ignored. A browser that reports nothing (iOS before 18.4) can still be lined up by ear with
the timing nudge.

**Timing by ear.** Some delay isn't reported at all. An iPhone playing through a Bluetooth speaker
says it's ~20 ms late when it's really ~200 ms late. So whenever you go live, and whenever a
device joins, the app checks each listener by ear with the Mac's microphone. It plays a short
chirp on the Mac's speakers and asks that device to play the same chirp 600 ms later, each with its
normal timing. How far the device's chirp lands from 600 ms after the Mac's is how far off it
plays. The device shifts by that much, and the room's buffer grows to make room for it.
This repeats until the device is within 15 ms, at most three rounds. Measuring the gap between two
sounds in one recording cancels out the microphone's own delay, and lines everyone up with this
Mac's speakers. The status area shows the result, e.g. "Synced convivial-badger: it was 190 ms
behind". The Mac's mic can hear speakers in the room, but not headphones. A device it can't hear is
left as it is, and the status area says so. **Re-check device timing** runs it again for everyone,
e.g. after a phone switches to a Bluetooth speaker. The chirps are short blips over the music. The
microphone is only open while a check runs (renderer/calibration.js, src/listenerCalibration.ts,
packages/shared/calibration.ts).

To remove the device:

```bash
sudo rm -rf /Library/Audio/Plug-Ins/HAL/Beatsync.driver && sudo killall coreaudiod
```

**Sync status.** The top of the window shows where the stream is: **Connect → Sync clocks →
Live**. While this Mac's clock syncs with the room, the Beatsync ring's arc fills as clean clock
samples arrive, with a progress bar and an "N of 8 samples" count. Once in sync, a green line shows
the clock offset and round trip.

**Sync target.** Below that, every other device in the room is plotted around this Mac by how far
off it is, with rings at 15 ms (inaudible) and 40 ms. A device turns solid green when the Mac's
microphone has heard it within 15 ms ("verified by ear"). Ripples mean it's being checked now, and
amber means it was corrected but not re-checked yet. A hollow dot means it's only clock-synced so
far, placed at its estimated error, and red on the outer ring means it couldn't be heard. A list
underneath gives each device's state and measured timing, plus a summary like "2 of 3 verified in
sync by ear". The menu bar popover shows the same as an early/late strip.

**Menu bar.** The app also lives in the menu bar (the ring icon, filled while you're live).
Click it for a small widget showing the stream status, a level meter, Room volume and
Start/Stop. Right-click for Open / Quit. Closing the main window keeps the app running there.

## Install (DMG)

```bash
cd apps/desktop && bun run dist      # → release/Beatsync Speaker-<version>-universal.dmg
```

Open the DMG and drag **Beatsync Speaker** into Applications. That's the whole install: the
capture helper, the Beatsync audio driver, and the room server and web app ship inside the app, and the driver installs
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
  Core Audio's storage. They're _not_ applied to the loopback. Its clock runs off the host clock. Output written by apps goes
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
- **`scripts/build-server.sh`**: builds the hosted room. `apps/server` is compiled with
  `bun build --compile` for arm64 and x64 and merged with `lipo` into `bin/beatsync-server`.
  `apps/client` is built as a static export (`BEATSYNC_STATIC_EXPORT=1`) into `build/web`. The export
  has one prerendered room page; the server (`apps/server/src/routes/static.ts`, on when
  `STATIC_DIR` is set) serves it for every `/room/<id>`, and the page reads the room code from the
  URL. With no API URL baked in, the web app talks to whatever origin served it.
- **`src/localServer.ts`**: checks the fixed port is free, runs `beatsync-server` with a clean environment (no S3
  keys, so state backups are off), and waits for `/health`. The server exits when its stdin
  closes, so it doesn't outlive the app even after a crash.

## Settings

| Setting                                              | Default                  | Notes                                                                                                      |
| ---------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Switch this Mac's output to Beatsync while streaming | on                       | Off: pick Beatsync yourself, system-wide or per app                                                        |
| Buffer                                               | 400 ms                   | Delay between playing on the Mac and hearing it in the room. Raise it if devices stutter on a busy network |
| Host the room on this Mac                            | on                       | Runs the bundled server and web app                                                                        |
| Port                                                 | 8095                     | The hosted room's port. It's in every join link, so keep it fixed                                          |
| Server WebSocket URL                                 | `ws://localhost:8080/ws` | External server, when not hosting the room                                                                 |
| Web app URL                                          | `http://localhost:3000`  | External web app, used by "Open room in browser" and the LAN link when not hosting                         |

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
