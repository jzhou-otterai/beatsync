// macOS lets the bundled server bind 0.0.0.0 on a port another process already holds on
// 127.0.0.1 (e.g. a dev server). The desktop app would then connect to that other
// process while phones reach the bundled one: two different rooms, and silence. The
// port is fixed (join links include it), so a taken port has to be reported, not
// silently swapped for another.

import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { isPortFree, LocalServer } from "../localServer";

const servers: Server[] = [];
const listen = (host: string): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen({ port: 0, host }, () => resolve((server.address() as { port: number }).port));
  });

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe("isPortFree", () => {
  it("sees a port held only on loopback as taken", async () => {
    const taken = await listen("127.0.0.1");
    expect(await isPortFree(taken)).toBe(false);
  });

  it("sees a released port as free", async () => {
    const port = await listen("0.0.0.0");
    servers.splice(0).forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 50));
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("LocalServer", () => {
  it("refuses a taken port instead of moving to another one", async () => {
    const taken = await listen("0.0.0.0");
    const server = new LocalServer({ binPath: "/nonexistent", webDir: "/tmp", dataDir: "/tmp", logDir: "/tmp" });
    await expect(server.ensureRunning(taken)).rejects.toThrow(`Port ${taken} is already in use`);
    expect(server.getPort()).toBeNull();
  });
});
