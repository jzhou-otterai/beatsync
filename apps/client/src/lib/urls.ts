/**
 * Resolves API and WS base URLs.
 *
 * If NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL are set, uses those (explicit mode).
 * Otherwise, derives from window.location (same-origin mode, for Caddy reverse proxy).
 */

let cached: { apiUrl: string; wsUrl: string } | null = null;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A localhost server URL only works on the machine running the server. When the page
 * itself was opened over the LAN (e.g. http://192.168.1.20:3000 on a phone), point the
 * server URL at that same host so other devices on the network can join a dev setup.
 */
function withPageHost(url: string): string {
  if (typeof window === "undefined") return url;
  const pageHost = window.location.hostname;
  try {
    const parsed = new URL(url);
    if (!LOOPBACK_HOSTS.has(parsed.hostname) || LOOPBACK_HOSTS.has(pageHost)) return url;
    parsed.hostname = pageHost;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function resolve(): { apiUrl: string; wsUrl: string } {
  if (cached) return cached;

  const envApi = process.env.NEXT_PUBLIC_API_URL;
  const envWs = process.env.NEXT_PUBLIC_WS_URL;

  if (envApi && envWs) {
    cached = { apiUrl: withPageHost(envApi), wsUrl: withPageHost(envWs) };
  } else if (typeof window !== "undefined") {
    const { protocol, host } = window.location;
    const isSecure = protocol === "https:";
    cached = {
      apiUrl: `${protocol}//${host}`,
      wsUrl: `${isSecure ? "wss" : "ws"}://${host}/ws`,
    };
  } else {
    // SSR fallback — don't cache empty strings so client can resolve properly after hydration
    return { apiUrl: "", wsUrl: "" };
  }

  return cached;
}

export function getApiUrl(): string {
  return resolve().apiUrl;
}

export function getWsUrl(): string {
  return resolve().wsUrl;
}
