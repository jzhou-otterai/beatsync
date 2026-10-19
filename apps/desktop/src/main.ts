import { LIVE_STREAM_CONSTANTS } from "@beatsync/shared";
import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { AudioCapture, probeDevice } from "./audioCapture";
import { Broadcaster, initialBroadcasterStatus, type BroadcasterStatus } from "./broadcaster";
import { driverNeedsInstall, installDriver } from "./driverInstall";
import { findLanAddress, lanJoinUrl } from "./lanUrl";
import { MenuBar } from "./tray";

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
  /** Fine-tunes the Mac's local copy against the room, in ms (+ = later) */
  macOffsetMs: number;
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
    {
      routeOutput: settings.routeOutput,
      playOnMac: settings.playOnMac,
      delayMs: settings.latencyMs,
      offsetMs: settings.macOffsetMs,
    },
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
      onRouted: (previousOutput) => sendToAll("note", { routedFrom: previousOutput }),
      onMonitoring: (device, delayMs) => sendToAll("note", { monitoring: { device, delayMs } }),
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

  // Packaged builds get the icon from icon.icns; in development, show it in the Dock too
  if (!app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), "resources", "icon.png"));
  menuBar = new MenuBar({ preloadPath: preloadPath(), onShowMain: showMainWindow });
  createWindow();
  app.on("activate", showMainWindow);
});

// Closing the window keeps streaming from the menu bar; quit from the menu bar icon
app.on("window-all-closed", () => {});

// Make sure the helper stops (and switches the Mac back to its previous output) on quit
app.on("before-quit", stopAll);
