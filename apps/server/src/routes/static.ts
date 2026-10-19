import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Serves a static export of the web client (apps/client built with BEATSYNC_STATIC_EXPORT=1)
 * from STATIC_DIR, so one origin serves both the app and the API/WebSocket. The Beatsync
 * Speaker desktop app runs the server this way; it's off unless STATIC_DIR is set.
 */
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;

export const IS_SERVING_CLIENT = STATIC_DIR !== null;

/**
 * The export prerenders a single room page for the placeholder ID "_" (STATIC_ROOM_PLACEHOLDER
 * in apps/client/src/lib/room.ts); every room's HTML and RSC files are served from it.
 */
const toExportPath = (pathname: string) => pathname.replace(/^\/room\/[^/.]+/, "/room/_");

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const findFile = (root: string, pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const base = resolve(join(root, decoded));
  if (base !== root && !base.startsWith(root + sep)) return null;
  for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
};

/** The client file for a GET/HEAD request, or null to fall through to a 404 */
export const handleStatic = (req: Request, pathname: string): Response | null => {
  if (!STATIC_DIR || (req.method !== "GET" && req.method !== "HEAD")) return null;
  const path = findFile(STATIC_DIR, toExportPath(pathname));
  if (!path) return null;
  // Build output under /_next/static is content-hashed; everything else may change between versions
  const cacheControl = pathname.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(Bun.file(path), { headers: { "Cache-Control": cacheControl } });
};
