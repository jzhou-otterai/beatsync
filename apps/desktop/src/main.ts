import { LIVE_STREAM_CONSTANTS } from "@beatsync/shared";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { AudioTap } from "./audioTap";
import { Broadcaster, type BroadcasterStatus } from "./broadcaster";

export interface Settings {
  wsUrl: string;
  webUrl: string;
  roomId: string;
  username: string;
  latencyMs: number;
  muteLocalOutput: boolean;
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
    muteLocalOutput: true,
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
    ? path.join(process.resourcesPath, "bin", "beatsync-audio-tap")
    : path.join(app.getAppPath(), "bin", "beatsync-audio-tap");

let win: BrowserWindow | null = null;
let settings: Settings;
let broadcaster: Broadcaster | null = null;
let tap: AudioTap | null = null;
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
  tap?.stop();
  tap = null;
  broadcaster?.disconnect();
  broadcaster = null;
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
};

const start = (next: Omit<Settings, "clientId">) => {
  stopAll();
  settings = { ...settings, ...next };
  saveSettings(settings);

  if (!existsSync(helperPath())) {
    sendStatus({ ...idleStatus(), phase: "error", message: `Capture helper missing at ${helperPath()}` });
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

  const t = new AudioTap(helperPath());
  tap = t;
  t.start(
    { muteLocalOutput: settings.muteLocalOutput },
    {
      onFormat: (format) => {
        // A format change mid-stream (e.g. output device switched) needs a fresh stream
        b.stopStream();
        b.startStream(format, settings.latencyMs, "Mac");
      },
      onData: (pcm) => {
        peakLevel = Math.max(peakLevel, peakOf(pcm));
        b.pushPcm(pcm);
      },
      onError: (message) => sendStatus({ ...b.getStatus(), phase: "error", message }),
      onExit: () => {
        if (tap === t) {
          sendStatus({ ...b.getStatus(), phase: "error", message: "Audio capture stopped unexpectedly" });
          tap = null;
        }
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
    height: 720,
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

// Make sure the helper releases the tap (and un-mutes the speakers) on quit
app.on("before-quit", stopAll);
