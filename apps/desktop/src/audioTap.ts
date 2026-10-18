import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface TapFormat {
  sampleRate: number;
  channels: number;
}

export interface AudioTapCallbacks {
  onFormat: (format: TapFormat) => void;
  onData: (pcm: Buffer) => void;
  onError: (message: string) => void;
  onExit: () => void;
}

/**
 * Runs the native `beatsync-audio-tap` helper, which captures macOS system audio
 * through a Core Audio process tap and streams s16le PCM on stdout.
 */
export class AudioTap {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly helperPath: string) {}

  get isRunning(): boolean {
    return this.proc !== null;
  }

  start(options: { muteLocalOutput: boolean }, callbacks: AudioTapCallbacks): void {
    if (this.proc) return;

    const args = options.muteLocalOutput ? ["--mute"] : [];
    const proc = spawn(this.helperPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => callbacks.onData(chunk));

    createInterface({ input: proc.stderr }).on("line", (line) => {
      try {
        const event = JSON.parse(line) as { event: string; message?: string; sampleRate?: number; channels?: number };
        if (event.event === "format" && event.sampleRate && event.channels) {
          callbacks.onFormat({ sampleRate: event.sampleRate, channels: event.channels });
        } else if (event.event === "error") {
          callbacks.onError(event.message ?? "Unknown capture error");
        }
      } catch {
        console.log(`[audio-tap] ${line}`);
      }
    });

    proc.on("error", (err) => callbacks.onError(`Could not start capture helper: ${err.message}`));
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
      callbacks.onExit();
    });
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    // SIGTERM lets the helper tear down its tap, which un-mutes the Mac's speakers
    proc.kill("SIGTERM");
    proc.stdin.end();
  }
}
