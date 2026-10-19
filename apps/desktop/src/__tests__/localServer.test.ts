// macOS lets the bundled server bind 0.0.0.0 on a port another process already holds on
// 127.0.0.1 (e.g. a dev server). The desktop app would then connect to that other
// process while phones reach the bundled one: two different rooms, and silence.

import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { pickPort } from "../localServer";

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

describe("pickPort", () => {
  it("skips a port held only on loopback", async () => {
    const taken = await listen("127.0.0.1");
    expect(await pickPort(taken)).not.toBe(taken);
  });

  it("keeps the preferred port when it's free", async () => {
    const free = await listen("0.0.0.0");
    servers.splice(0).forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 50));
    expect(await pickPort(free)).toBe(free);
  });
});
