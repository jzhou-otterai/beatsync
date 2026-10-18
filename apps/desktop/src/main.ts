import { LIVE_STREAM_CONSTANTS } from "@beatsync/shared";
import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { AudioCapture, probeDevice } from "./audioCapture";
import { Broadcaster, type BroadcasterStatus } from "./broadcaster";
import { driverNeedsInstall, installDriver } from "./driverInstall";
import { findLanAddress, lanJoinUrl } from "./lanUrl";

export interface Settings {
  wsUrl: string;
  webUrl: string;
  roomId: string;
  username: string;
  latencyMs: number;
  /** Make Beatsync the Mac's output while streaming, and switch back afterwards */
  routeOutput: boolean;
  /** Keep playing on the Mac's own speakers too, delayed to match the room */
  playOnMac: boolean;
  clientId: string;
}

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

const loadSettings = (): Settings => {
  const defaults: Settings = {
    wsUrl: "ws://localhost:8080/ws",
    webUrl: "http://localhost:3000",
    roomId: "",
    username: hostname().replace(/\.local$/, ""),
    latencyMs: LIVE_STREAM_CONSTANTS.DEFAULT_LATENCY_MS,
    routeOutput: true,
    playOnMac: true,
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
  win?.webContents.send("device", after);
  return after.installed
    ? null
    : "Installed the audio device, but Core Audio hasn't picked it up yet. Try restarting your Mac.";
};

let win: BrowserWindow | null = null;
let settings: Settings;
let broadcaster: Broadcaster | null = null;
let capture: AudioCapture | null = null;
let peakLevel = 0;
let levelTimer: ReturnType<typeof setInterval> | null = null;

const sendStatus = (status: BroadcasterStatus) => {
  win?.webContents.send("status", status);
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

  const b = new Broadcaster({
    wsUrl: settings.wsUrl,
    roomId: settings.roomId,
    username: settings.username,
    clientId: settings.clientId,
    onStatus: sendStatus,
  });
  broadcaster = b;
  b.connect();

  const c = new AudioCapture(helperPath());
  capture = c;
  c.start(
    { routeOutput: settings.routeOutput, playOnMac: settings.playOnMac, delayMs: settings.latencyMs },
    {
      onFormat: (format) => {
        // A format change mid-stream (e.g. sample rate changed in Audio MIDI Setup) needs a fresh stream
        b.stopStream();
        b.startStream(format, settings.latencyMs, "Mac");
      },
      onData: (pcm) => {
        peakLevel = Math.max(peakLevel, peakOf(pcm));
        b.pushPcm(pcm);
      },
      onRouted: (previousOutput) => win?.webContents.send("note", { routedFrom: previousOutput }),
      onMonitoring: (device, delayMs) => win?.webContents.send("note", { monitoring: { device, delayMs } }),
      onWarning: (message) => win?.webContents.send("note", { warning: message }),
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
    win?.webContents.send("level", peakLevel);
    peakLevel = 0;
  }, 100);
};

const idleStatus = (): BroadcasterStatus => ({
  phase: "idle",
  rttMs: 0,
  offsetMs: 0,
  ntpMeasurements: 0,
  isAdmin: false,
  listeners: 0,
  framesSent: 0,
  framesDropped: 0,
  reanchors: 0,
  liveStream: null,
});

const createWindow = () => {
  win = new BrowserWindow({
    width: 420,
    height: 860,
    minWidth: 420,
    maxWidth: 420,
    minHeight: 560,
    title: "Beatsync Speaker",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      // getAppPath(), not __dirname: the bundler inlines __dirname as the source directory
      preload: path.join(app.getAppPath(), "dist", "preload.js"),
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
  saveSettings(settings); // persist the generated clientId

  ipcMain.handle("get-initial-state", () => {
    const { clientId: _clientId, ...rest } = settings;
    return { settings: rest, status: broadcaster?.getStatus() ?? idleStatus() };
  });
  ipcMain.handle("start", (_event, next: Omit<Settings, "clientId">) => start(next));
  ipcMain.handle("stop", () => {
    stopAll();
    sendStatus(idleStatus());
  });
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
  ipcMain.handle("copy-lan-link", (_event, form: { webUrl: string; roomId: string }) => {
    if (!/^\d{6}$/.test(form.roomId)) return { ok: false, message: "Enter a 6-digit room code first" };
    const url = lanJoinUrl(form.webUrl, form.roomId, findLanAddress(networkInterfaces()));
    if (!url) return { ok: false, message: "Couldn't find this Mac's local network address — is Wi-Fi connected?" };
    clipboard.writeText(url);
    return { ok: true, url };
  });
  ipcMain.handle("open-room", () => {
    if (settings.roomId) shell.openExternal(`${settings.webUrl.replace(/\/$/, "")}/room/${settings.roomId}`);
  });

  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopAll();
  app.quit();
});

// Make sure the helper stops (and switches the Mac back to its previous output) on quit
app.on("before-quit", stopAll);
