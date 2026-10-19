import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

export const DEFAULT_LOCAL_PORT = 8090;

/** Whether `port` can be bound on `host` right now */
const canListen = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });

/** A port the OS says is free */
const randomFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "0.0.0.0" }, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/**
 * `preferred` if nothing listens on it, else a random free port. Checks loopback too:
 * macOS lets a 0.0.0.0 listener coexist with another process's 127.0.0.1 one on the
 * same port, and then this Mac's own connections would reach the other process.
 */
export const pickPort = async (preferred: number): Promise<number> =>
  (await canListen(preferred, "0.0.0.0")) && (await canListen(preferred, "127.0.0.1")) ? preferred : randomFreePort();

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
  preferredPort?: number;
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

  /** Start the server unless it's already running; resolves with its port */
  ensureRunning(): Promise<number> {
    if (this.proc && this.port !== null) return Promise.resolve(this.port);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<number> {
    const { binPath, webDir, dataDir, logDir, preferredPort = DEFAULT_LOCAL_PORT } = this.options;
    const port = await pickPort(preferredPort);

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
