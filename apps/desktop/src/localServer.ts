import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

/**
 * Fixed, so a join link opened on a speaker keeps working every time the app hosts the
 * room. Clear of this repo's dev ports (3000 web, 8080/8090 server), so it doesn't collide
 * with `bun dev`.
 */
export const DEFAULT_LOCAL_PORT = 8095;

/** Whether `port` can be bound on `host` right now */
const canListen = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });

/**
 * Whether nothing else listens on `port`. Checks loopback too: macOS lets a 0.0.0.0
 * listener coexist with another process's 127.0.0.1 one on the same port, and then this
 * Mac's own connections would reach the other process.
 */
export const isPortFree = async (port: number): Promise<boolean> =>
  (await canListen(port, "0.0.0.0")) && (await canListen(port, "127.0.0.1"));

const isHealthy = async (port: number) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
};

export interface LocalServerOptions {
  /** The `beatsync-server` executable (apps/server compiled with `bun build --compile`) */
  binPath: string;
  /** Static export of the web client, served from the same port */
  webDir: string;
  /** Working directory; also where server.log goes */
  dataDir: string;
  logDir: string;
}

/**
 * Runs the Beatsync server bundled with the app, serving the web client and the room's
 * API/WebSocket from one port on every network interface, so phones on the same Wi-Fi
 * can open the LAN join link with nothing else running.
 */
export class LocalServer {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;

  constructor(private readonly options: LocalServerOptions) {}

  /** The port it listens on, once running */
  getPort(): number | null {
    return this.proc ? this.port : null;
  }

  /**
   * Start the server on `port` unless it's already running there (restarting it if the
   * port changed); resolves with the port. Never falls back to another port: links
   * already handed out would silently point at nothing, or at a different server.
   */
  async ensureRunning(port: number): Promise<number> {
    if (this.starting) await this.starting.catch(() => {});
    if (this.proc && this.port === port) return port;
    this.stop();
    this.starting = this.start(port).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(port: number): Promise<number> {
    const { binPath, webDir, dataDir, logDir } = this.options;
    if (!(await isPortFree(port))) {
      throw new Error(
        `Port ${port} is already in use by another app, so the room can't be hosted on it. Quit that app, or pick another port under Advanced.`
      );
    }

    mkdirSync(logDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const log = createWriteStream(path.join(logDir, "server.log"));
    let lastOutput = "";

    const proc = spawn(binPath, [], {
      cwd: dataDir,
      // A clean environment: no S3 keys or PORT from wherever the app was launched
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        PORT: String(port),
        STATIC_DIR: webDir,
        EXIT_WITH_STDIN: "1",
      },
      // stdin stays open for the server's lifetime; it exits when this process goes away
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        log.write(chunk);
        lastOutput = (lastOutput + chunk.toString()).slice(-2000);
      });
    }
    this.proc = proc;
    this.port = port;

    let exited = false;
    proc.on("exit", (code, signal) => {
      exited = true;
      log.end(`\n[exited code=${code} signal=${signal}]\n`);
      if (this.proc === proc) {
        this.proc = null;
        this.port = null;
      }
    });
    proc.on("error", (error) => {
      exited = true;
      lastOutput += `\n${error.message}`;
      if (this.proc === proc) {
        this.proc = null;
        this.port = null;
      }
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (exited) break;
      if (await isHealthy(port)) return port;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.stop();
    const detail = lastOutput.trim().split("\n").slice(-3).join(" ");
    throw new Error(`The room server didn't start${detail ? `: ${detail}` : ""}`);
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    if (!proc) return;
    proc.stdin?.end();
    proc.kill("SIGTERM");
  }
}
