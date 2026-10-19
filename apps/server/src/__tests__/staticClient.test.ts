// The desktop app's static export prerenders one room page ("_") that every /room/<id>
// must be served from, including the RSC payloads Next fetches on client navigation;
// a miss there only shows up as a blank room on someone's phone.

import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { handleStatic as HandleStatic } from "@/routes/static";

let handleStatic: typeof HandleStatic;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "beatsync-static-"));
  const root = join(dir, "web");
  mkdirSync(join(root, "room", "_"), { recursive: true });
  writeFileSync(join(root, "index.html"), "home");
  writeFileSync(join(root, "room", "_.html"), "room page");
  writeFileSync(join(root, "room", "_.txt"), "room rsc");
  writeFileSync(join(root, "room", "_", "__next.room.$d$roomId.__PAGE__.txt"), "segment");
  writeFileSync(join(dir, "secret.txt"), "secret");
  process.env.STATIC_DIR = root;
  ({ handleStatic } = await import("@/routes/static"));
});

const get = async (pathname: string) => {
  const res = handleStatic(new Request(`http://localhost${pathname}`), pathname);
  return res ? await res.text() : null;
};

describe("handleStatic", () => {
  it("serves every room from the placeholder page", async () => {
    expect(await get("/")).toBe("home");
    expect(await get("/room/123456")).toBe("room page");
    expect(await get("/room/123456.txt")).toBe("room rsc");
    expect(await get("/room/123456/__next.room.$d$roomId.__PAGE__.txt")).toBe("segment");
  });

  it("falls through for API routes and paths outside the export", async () => {
    expect(await get("/stats")).toBeNull();
    expect(await get("/%2e%2e/secret.txt")).toBeNull();
  });
});
