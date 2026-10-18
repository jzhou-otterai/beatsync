import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CaptureFormat {
  sampleRate: number;
  channels: number;
}

export interface DeviceStatus {
  /** The Beatsync virtual audio device is registered with Core Audio */
  installed: boolean;
  microphone: "granted" | "denied" | "undetermined";
}

export interface AudioCaptureCallbacks {
  onFormat: (format: CaptureFormat) => void;
  onData: (pcm: Buffer) => void;
  onRouted: (previousOutput: string) => void;
  onError: (message: string) => void;
  /** `error` is the last error the helper reported, if it exited because of one */
  onExit: (error: string | null) => void;
}

interface HelperEvent {
  event: string;
  code?: string;
  message?: string;
  sampleRate?: number;
  channels?: number;
  previousOutput?: string;
  installed?: boolean;
  microphone?: DeviceStatus["microphone"];
}

/** Ask the helper whether the Beatsync device is installed and Microphone access is granted */
export const probeDevice = (helperPath: string): Promise<DeviceStatus> =>
  new Promise((resolve) => {
    execFile(helperPath, ["probe"], { timeout: 5000 }, (_err, _stdout, stderr) => {
      const line = stderr.split("\n").find((l) => l.includes('"probe"'));
      try {
        const event = JSON.parse(line ?? "") as HelperEvent;
        resolve({ installed: !!event.installed, microphone: event.microphone ?? "undetermined" });
      } catch {
        resolve({ installed: false, microphone: "undetermined" });
      }
    });
  });

/**
 * Runs the native `beatsync-audio-capture` helper, which reads the Beatsync virtual
 * audio device (whatever the Mac plays into it) and streams s16le PCM on stdout.
 */
export class AudioCapture {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly helperPath: string) {}

  start(options: { routeOutput: boolean }, callbacks: AudioCaptureCallbacks): void {
    if (this.proc) return;

    const args = ["capture", ...(options.routeOutput ? ["--route"] : [])];
    const proc = spawn(this.helperPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    let lastError: string | null = null;

    proc.stdout.on("data", (chunk: Buffer) => callbacks.onData(chunk));

    createInterface({ input: proc.stderr }).on("line", (line) => {
      let event: HelperEvent;
      try {
        event = JSON.parse(line) as HelperEvent;
      } catch {
        console.log(`[audio-capture] ${line}`);
        return;
      }
      if (event.event === "format" && event.sampleRate && event.channels) {
        callbacks.onFormat({ sampleRate: event.sampleRate, channels: event.channels });
      } else if (event.event === "routed") {
        callbacks.onRouted(event.previousOutput ?? "previous output");
      } else if (event.event === "error") {
        lastError = event.message ?? "Unknown capture error";
        callbacks.onError(lastError);
      }
    });

    proc.on("error", (err) => callbacks.onError(`Could not start capture helper: ${err.message}`));
    proc.on("exit", () => {
      if (this.proc !== proc) return; // stopped on purpose
      this.proc = null;
      callbacks.onExit(lastError);
    });
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    // SIGTERM lets the helper switch the Mac back to its previous output
    proc.kill("SIGTERM");
    proc.stdin.end();
  }
}
