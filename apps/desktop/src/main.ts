import { LIVE_STREAM_CONSTANTS } from "@beatsync/shared";
import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { AudioCapture, probeDevice } from "./audioCapture";
import { Broadcaster, initialBroadcasterStatus, type BroadcasterStatus } from "./broadcaster";
import { effectiveBufferMs, MIN_BUFFER_CHANGE_MS } from "./bufferSizing";
import { driverNeedsInstall, installDriver } from "./driverInstall";
import { findLanAddress, lanJoinUrl } from "./lanUrl";
import { ListenerCalibration } from "./listenerCalibration";
import { DEFAULT_LOCAL_PORT, LocalServer } from "./localServer";
import { MicCalibrator } from "./micCalibrator";
import { MenuBar } from "./tray";

export interface Settings {
  /** Run the server and web app bundled with this app, instead of the wsUrl/webUrl below */
  hostLocally: boolean;
  /** Port the bundled server listens on; fixed so join links keep working */
  localPort: number;
  /** An external Beatsync server, used when not hosting locally */
  wsUrl: string;
  webUrl: string;
  roomId: string;
  username: string;
  latencyMs: number;
  /** Make Beatsync the Mac's output while streaming, and switch back afterwards */
  routeOutput: boolean;
  /** Keep playing on the Mac's own speakers too, delayed to match the room */
  playOnMac: boolean;
  /** Fine-tunes the Mac's local copy against the room, in ms (+ = later) */
  macOffsetMs: number;
  clientId: string;
}

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

const loadSettings = (): Settings => {
  const defaults: Settings = {
    hostLocally: true,
    localPort: DEFAULT_LOCAL_PORT,
    wsUrl: "ws://localhost:8080/ws",
    webUrl: "http://localhost:3000",
    roomId: "",
    username: hostname().replace(/\.local$/, ""),
    latencyMs: LIVE_STREAM_CONSTANTS.DEFAULT_LATENCY_MS,
    routeOutput: true,
    playOnMac: true,
    macOffsetMs: 0,
    clientId: randomUUID(),
  };
  try {
    return { ...defaults, ...(JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<Settings>) };
  } catch {
    return defaults;
  }
};

const saveSettings = (settings: Settings) => {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
};

const helperPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "bin", "beatsync-audio-capture")
    : path.join(app.getAppPath(), "bin", "beatsync-audio-capture");

const driverPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "driver", "Beatsync.driver")
    : path.join(app.getAppPath(), "build", "Beatsync.driver");

const serverPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "bin", "beatsync-server")
    : path.join(app.getAppPath(), "bin", "beatsync-server");

const webPath = () =>
  app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(app.getAppPath(), "build", "web");

let localServer: LocalServer;

/**
 * Where the room lives: the server bundled with the app (started on first use, so nothing
 * listens on the network until it's needed), or the external one set under Advanced
 */
const resolveUrls = async (s: Pick<Settings, "hostLocally" | "localPort" | "wsUrl" | "webUrl">) => {
  if (!s.hostLocally) {
    localServer.stop();
    return { wsUrl: s.wsUrl, webUrl: s.webUrl };
  }
  if (!Number.isInteger(s.localPort) || s.localPort < 1024 || s.localPort > 65535) {
    throw new Error("Pick a port between 1024 and 65535 under Advanced");
  }
  const port = await localServer.ensureRunning(s.localPort);
  return { wsUrl: `ws://127.0.0.1:${port}/ws`, webUrl: `http://127.0.0.1:${port}` };
};

const appendCalibrationLog = (line: string) => {
  try {
    mkdirSync(app.getPath("logs"), { recursive: true });
    appendFileSync(path.join(app.getPath("logs"), "calibration.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging is best effort
  }
};

/**
 * Keep the last few calibration recordings (raw float32 mono + where the reference was
 * scheduled), so a timing problem in a real room can be analyzed after the fact
 */
let recordingCount = 0;
const saveCalibrationRecording = (rec: { recording: Float32Array; refIndex: number; sampleRate: number }) => {
  try {
    const dir = path.join(app.getPath("logs"), "calibration");
    mkdirSync(dir, { recursive: true });
    const name = `rec-${recordingCount++ % 5}`;
    writeFileSync(
      path.join(dir, `${name}.f32`),
      Buffer.from(rec.recording.buffer, rec.recording.byteOffset, rec.recording.byteLength)
    );
    writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({ refIndex: rec.refIndex, sampleRate: rec.sampleRate, at: new Date().toISOString() })
    );
  } catch {
    // Diagnostics are best effort
  }
};

/** Core Audio takes a moment to come back after a restart */
const waitForDevice = async (timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await probeDevice(helperPath());
    if (status.installed || Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, 500));
  }
};

/**
 * Make sure the Beatsync device is installed and current, installing the driver
 * bundled with the app if not. Returns an error message, or null when ready.
 */
const ensureDevice = async (): Promise<string | null> => {
  const status = await probeDevice(helperPath());
  if (status.installed && !driverNeedsInstall(driverPath())) return null;

  sendStatus({ ...idleStatus(), phase: "connecting", message: "Installing the Beatsync audio device…" });
  const result = await installDriver(driverPath());
  if (!result.ok) return result.message;

  const after = await waitForDevice();
  sendToAll("device", after);
  return after.installed
    ? null
    : "Installed the audio device, but Core Audio hasn't picked it up yet. Try restarting your Mac.";
};

let win: BrowserWindow | null = null;
let menuBar: MenuBar | null = null;
let micCalibrator: MicCalibrator | null = null;
let calibration: ListenerCalibration | null = null;
let listeners: { clientId: string; username: string }[] = [];
/** The Mac's real speakers, where its own copy plays (from the capture helper) */
let monitorDeviceName: string | null = null;
let settings: Settings;
let broadcaster: Broadcaster | null = null;
let capture: AudioCapture | null = null;
let peakLevel = 0;
let levelTimer: ReturnType<typeof setInterval> | null = null;

/** Send to every renderer: the main window and the menu bar popover */
const sendToAll = (channel: string, payload: unknown) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
};

const sendStatus = (status: BroadcasterStatus) => {
  sendToAll("status", status);
  menuBar?.updateStatus(status);
};

const peakOf = (pcm: Buffer): number => {
  let peak = 0;
  // Sample every 8th value — plenty for a meter
  for (let i = 0; i + 1 < pcm.length; i += 16) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak / 32768;
};

const stopAll = () => {
  calibration?.stop();
  calibration = null;
  capture?.stop();
  capture = null;
  broadcaster?.disconnect();
  broadcaster = null;
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
};

const start = async (next: Omit<Settings, "clientId">) => {
  stopAll();
  settings = { ...settings, ...next };
  saveSettings(settings);

  if (!existsSync(helperPath())) {
    sendStatus({ ...idleStatus(), phase: "error", message: `Capture helper missing at ${helperPath()}` });
    return;
  }

  const deviceError = await ensureDevice();
  if (deviceError) {
    sendStatus({ ...idleStatus(), phase: "error", message: deviceError });
    return;
  }

  let wsUrl: string;
  try {
    if (settings.hostLocally)
      sendStatus({ ...idleStatus(), phase: "connecting", message: "Starting the room server…" });
    const urls = await resolveUrls(settings);
    wsUrl = urls.wsUrl;
    if (settings.hostLocally) {
      sendToAll("note", { hosting: lanJoinUrl(urls.webUrl, settings.roomId, findLanAddress(networkInterfaces())) });
    }
  } catch (error) {
    sendStatus({ ...idleStatus(), phase: "error", message: (error as Error).message });
    return;
  }

  // The buffer in use: the configured one, raised while a listener needs more lead
  // (Bluetooth on a phone). The Mac's own copy is delayed by the same amount.
  let bufferMs = settings.latencyMs;
  let lastPhase: BroadcasterStatus["phase"] = "idle";
  const b = new Broadcaster({
    wsUrl,
    roomId: settings.roomId,
    username: settings.username,
    clientId: settings.clientId,
    onStatus: (status) => {
      // Going live: time whoever is already in the room
      if (status.phase === "live" && lastPhase !== "live") calibration?.updateListeners(listeners);
      lastPhase = status.phase;
      sendStatus(status);
    },
    // Time each listener with the Mac's microphone as it joins (e.g. a phone on a Bluetooth speaker)
    onListeners: (next) => {
      listeners = next;
      if (b.getStatus().phase === "live") calibration?.updateListeners(next);
    },
    onListenerCompensation: (maxMs) => {
      const next = effectiveBufferMs(settings.latencyMs, maxMs);
      if (Math.abs(next - bufferMs) < MIN_BUFFER_CHANGE_MS) return;
      bufferMs = next;
      b.setLatency(next);
      capture?.setDelay(next);
      // Wired outputs add ~10-40ms; only call out Bluetooth-sized delays
      sendToAll("note", { buffer: maxMs >= 80 ? { ms: next, listenerMs: maxMs } : null });
    },
  });
  broadcaster = b;
  b.connect();

  const mic = micCalibrator;
  calibration = mic
    ? new ListenerCalibration({
        serverNow: () => b.serverNow(),
        clockOffsetMs: () => b.clockOffsetMs(),
        sendChirp: (id, chirpId, at) => b.sendCalibrationChirp(id, chirpId, at),
        sendResult: (id, chirpId, ms) => b.sendCalibrationResult(id, chirpId, ms),
        measure: async (at, chirp, recordMs) => {
          const rec = await mic.measure(at, chirp, recordMs);
          saveCalibrationRecording(rec);
          return rec;
        },
        sampleRate: async () => (await mic.start()).sampleRate,
        release: () => mic.stop(),
        onNote: (message) => {
          sendToAll("note", { calibration: message });
          appendCalibrationLog(message);
        },
        log: appendCalibrationLog,
      })
    : null;

  const c = new AudioCapture(helperPath());
  capture = c;
  c.start(
    {
      routeOutput: settings.routeOutput,
      playOnMac: settings.playOnMac,
      delayMs: bufferMs,
      offsetMs: settings.macOffsetMs,
    },
    {
      onFormat: (format) => {
        // A format change mid-stream (e.g. sample rate changed in Audio MIDI Setup) needs a fresh stream
        b.stopStream();
        b.startStream(format, bufferMs, "Mac");
      },
      onData: (pcm) => {
        peakLevel = Math.max(peakLevel, peakOf(pcm));
        b.pushPcm(pcm);
      },
      onRouted: (previousOutput) => sendToAll("note", { routedFrom: previousOutput }),
      onMonitoring: (device, delayMs) => {
        monitorDeviceName = device;
        sendToAll("note", { monitoring: { device, delayMs } });
      },
      onWarning: (message) => sendToAll("note", { warning: message }),
      onError: (message) => sendStatus({ ...b.getStatus(), phase: "error", message }),
      onExit: (error) => {
        if (capture !== c) return;
        capture = null;
        // The helper exits on fatal errors (device missing, no Microphone access); leave
        // the room too so it isn't stuck on a silent "live" stream
        b.disconnect();
        sendStatus({ ...b.getStatus(), phase: "error", message: error ?? "Audio capture stopped unexpectedly" });
      },
    }
  );

  levelTimer = setInterval(() => {
    sendToAll("level", peakLevel);
    peakLevel = 0;
  }, 100);
};

const idleStatus = initialBroadcasterStatus;

const preloadPath = () => path.join(app.getAppPath(), "dist", "preload.js");

const showMainWindow = () => {
  if (!win) createWindow();
  win?.show();
  win?.focus();
};

const createWindow = () => {
  win = new BrowserWindow({
    width: 420,
    height: 920,
    minWidth: 420,
    maxWidth: 420,
    minHeight: 560,
    title: "Beatsync Speaker",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      // getAppPath(), not __dirname: the bundler inlines __dirname as the source directory
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(app.getAppPath(), "renderer", "index.html"));
  win.on("closed", () => {
    win = null;
  });
};

app.whenReady().then(() => {
  settings = loadSettings();
  localServer = new LocalServer({
    binPath: serverPath(),
    webDir: webPath(),
    dataDir: path.join(app.getPath("userData"), "server"),
    logDir: app.getPath("logs"),
  });
  saveSettings(settings); // persist the generated clientId

  ipcMain.handle("get-initial-state", () => {
    const { clientId: _clientId, ...rest } = settings;
    return { settings: rest, status: broadcaster?.getStatus() ?? idleStatus() };
  });
  ipcMain.handle("start", (_event, next: Omit<Settings, "clientId">) => start(next));
  // Menu bar popover: start with the saved settings, or bring up the full window
  ipcMain.handle("start-saved", () => {
    if (!/^\d{6}$/.test(settings.roomId)) {
      showMainWindow();
      return { ok: false, message: "Set a room code first" };
    }
    const { clientId: _clientId, ...rest } = settings;
    void start(rest);
    return { ok: true };
  });
  ipcMain.handle("show-main", () => {
    menuBar?.hidePopover();
    showMainWindow();
  });
  ipcMain.handle("stop", () => {
    stopAll();
    sendStatus(idleStatus());
  });
  ipcMain.handle("set-mac-offset", (_event, ms: number) => {
    settings.macOffsetMs = Math.max(-500, Math.min(500, Math.round(ms)));
    saveSettings(settings);
    capture?.setMonitorOffset(settings.macOffsetMs);
  });
  ipcMain.handle("set-room-volume", (_event, volume: number) => broadcaster?.setGlobalVolume(volume));
  ipcMain.handle("device-status", async () => ({
    ...(await probeDevice(helperPath())),
    updateAvailable: driverNeedsInstall(driverPath()),
  }));
  ipcMain.handle("install-device", async () => {
    const error = await ensureDevice();
    return { error, status: await probeDevice(helperPath()) };
  });
  ipcMain.handle("open-sound-settings", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.Sound-Settings.extension")
  );
  ipcMain.handle(
    "copy-lan-link",
    async (_event, form: Pick<Settings, "hostLocally" | "localPort" | "wsUrl" | "webUrl" | "roomId">) => {
      if (!/^\d{6}$/.test(form.roomId)) return { ok: false, message: "Enter a 6-digit room code first" };
      let webUrl: string;
      try {
        // Hosting locally: start the server now, so phones can join before streaming starts
        ({ webUrl } = await resolveUrls(form));
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
      const url = lanJoinUrl(webUrl, form.roomId, findLanAddress(networkInterfaces()));
      if (!url) return { ok: false, message: "Couldn't find this Mac's local network address — is Wi-Fi connected?" };
      clipboard.writeText(url);
      return { ok: true, url };
    }
  );
  ipcMain.handle("recheck-timing", () => {
    if (broadcaster?.getStatus().phase !== "live" || !calibration) {
      return { ok: false, message: "Start streaming first" };
    }
    if (!listeners.length) return { ok: false, message: "No one else is in the room yet" };
    calibration.recheck(listeners);
    return { ok: true, message: `Checking timing of ${listeners.length} device${listeners.length === 1 ? "" : "s"}…` };
  });
  ipcMain.handle("open-room", async () => {
    if (!settings.roomId) return;
    try {
      const { webUrl } = await resolveUrls(settings);
      await shell.openExternal(`${webUrl.replace(/\/$/, "")}/room/${settings.roomId}`);
    } catch (error) {
      sendStatus({ ...(broadcaster?.getStatus() ?? idleStatus()), phase: "error", message: (error as Error).message });
    }
  });

  // Packaged builds get the icon from icon.icns; in development, show it in the Dock too
  if (!app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), "resources", "icon.png"));
  menuBar = new MenuBar({ preloadPath: preloadPath(), onShowMain: showMainWindow });
  micCalibrator = new MicCalibrator({
    appPath: app.getAppPath(),
    preloadPath: path.join(app.getAppPath(), "dist", "calibrationPreload.js"),
    outputDeviceName: () => monitorDeviceName,
  });
  createWindow();
  app.on("activate", showMainWindow);
});

// Closing the window keeps streaming from the menu bar; quit from the menu bar icon
app.on("window-all-closed", () => {});

// Make sure the helper stops (and switches the Mac back to its previous output) on quit,
// and the room server with it
app.on("before-quit", () => {
  stopAll();
  localServer?.stop();
});
