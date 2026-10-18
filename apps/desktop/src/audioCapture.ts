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
  /** Also playing on the Mac's own output, held back by `delayMs` to match the room */
  onMonitoring: (device: string, delayMs: number) => void;
  onError: (message: string) => void;
  onWarning: (message: string) => void;
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
  device?: string;
  delayMs?: number;
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
  private roomVolume = 1;

  constructor(private readonly helperPath: string) {}

  start(
    options: { routeOutput: boolean; playOnMac: boolean; delayMs: number },
    callbacks: AudioCaptureCallbacks
  ): void {
    if (this.proc) return;

    const args = [
      "capture",
      ...(options.routeOutput ? ["--route"] : []),
      ...(options.playOnMac ? ["--monitor", "--delay-ms", String(Math.round(options.delayMs))] : []),
    ];
    const proc = spawn(this.helperPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    let lastError: string | null = null;

    // The room volume may have been set before the helper started
    proc.stdin.write(`room-volume ${this.roomVolume}\n`);
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
      } else if (event.event === "monitoring") {
        callbacks.onMonitoring(event.device ?? "this Mac", event.delayMs ?? 0);
      } else if (event.event === "routed") {
        callbacks.onRouted(event.previousOutput ?? "previous output");
      } else if (event.event === "error") {
        // Monitor problems are warnings: the room still gets audio
        if (event.code?.startsWith("monitor-")) {
          callbacks.onWarning(event.message ?? "Can't play on this Mac too");
          return;
        }
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

  /** Room-wide volume (0-1); scales the Mac's local copy along with its own volume keys */
  setRoomVolume(volume: number): void {
    this.roomVolume = volume;
    if (this.proc?.stdin.writable) this.proc.stdin.write(`room-volume ${volume}\n`);
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
