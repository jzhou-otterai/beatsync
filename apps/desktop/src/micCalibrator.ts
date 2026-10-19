import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";

export interface MicRecording {
  recording: Float32Array;
  /** Index in `recording` where the reference chirp was scheduled to start */
  refIndex: number;
  sampleRate: number;
}

interface MeasureResult extends Partial<MicRecording> {
  id: number;
  error?: string;
}

/**
 * Owns the hidden window that records the Mac's microphone and plays the reference
 * chirp on the Mac's speakers (renderer/calibration.js). Opened only while listeners
 * are being timed.
 */
export class MicCalibrator {
  private win: BrowserWindow | null = null;
  private starting: Promise<{ sampleRate: number }> | null = null;
  private pending = new Map<number, (result: MeasureResult) => void>();
  private nextId = 1;

  constructor(private readonly opts: { appPath: string; preloadPath: string; outputDeviceName: () => string | null }) {
    ipcMain.on("cal-result", (_event, result: MeasureResult) => {
      this.pending.get(result.id)?.(result);
      this.pending.delete(result.id);
    });
  }

  /** Open the microphone (once); resolves with its sample rate */
  start(): Promise<{ sampleRate: number }> {
    this.starting ??= new Promise<{ sampleRate: number }>((resolve, reject) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: this.opts.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          autoplayPolicy: "no-user-gesture-required",
        },
      });
      this.win = win;
      const cleanup = () => {
        ipcMain.removeListener("cal-ready", onReady);
        ipcMain.removeListener("cal-error", onError);
      };
      const onReady = (event: Electron.IpcMainEvent, info: { sampleRate: number; input: string; output: string }) => {
        if (event.sender !== win.webContents) return;
        cleanup();
        console.log(`[calibration] mic "${info.input}", reference on "${info.output}" @ ${info.sampleRate} Hz`);
        resolve(info);
      };
      const onError = (event: Electron.IpcMainEvent, message: string) => {
        if (event.sender !== win.webContents) return;
        cleanup();
        this.stop();
        reject(new Error(message));
      };
      ipcMain.on("cal-ready", onReady);
      ipcMain.on("cal-error", onError);
      win.webContents.once("did-finish-load", () =>
        win.webContents.send("cal-start", { outputDeviceName: this.opts.outputDeviceName() })
      );
      void win.loadFile(path.join(this.opts.appPath, "renderer", "calibration.html"));
    });
    return this.starting;
  }

  /**
   * Play the reference chirp so it's heard at `refAtLocalEpochMs` (this machine's
   * clock) and record the microphone from just before it until `recordMs` after.
   */
  async measure(refAtLocalEpochMs: number, chirp: Float32Array, recordMs: number): Promise<MicRecording> {
    await this.start();
    const win = this.win;
    if (!win) throw new Error("Microphone window closed");
    const id = this.nextId++;
    const result = await new Promise<MeasureResult>((resolve) => {
      this.pending.set(id, resolve);
      win.webContents.send("cal-measure", { id, refAtLocalEpochMs, chirp, recordMs });
    });
    if (result.error || !result.recording) throw new Error(result.error ?? "No recording");
    return { recording: result.recording, refIndex: result.refIndex ?? 0, sampleRate: result.sampleRate ?? 48000 };
  }

  /** Release the microphone */
  stop(): void {
    const win = this.win;
    this.win = null;
    this.starting = null;
    for (const resolve of this.pending.values()) resolve({ id: -1, error: "Stopped" });
    this.pending.clear();
    if (win && !win.isDestroyed()) {
      win.webContents.send("cal-stop");
      win.destroy();
    }
  }
}
