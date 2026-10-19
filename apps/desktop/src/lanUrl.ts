import type { NetworkInterfaceInfo } from "node:os";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isPrivateIPv4 = (ip: string) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/**
 * The Mac's address on the local network. Prefers Wi-Fi/Ethernet (en*) private IPv4
 * addresses over VPN tunnels, Docker bridges and the like.
 */
export const findLanAddress = (interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null => {
  const candidates = Object.entries(interfaces).flatMap(([name, infos]) =>
    (infos ?? [])
      .filter((info) => info.family === "IPv4" && !info.internal && isPrivateIPv4(info.address))
      .map((info) => ({ name, address: info.address }))
  );
  const preferred = candidates.find((c) => /^en\d+$/.test(c.name)) ?? candidates[0];
  return preferred?.address ?? null;
};

/**
 * Join link other devices on the network can open. A localhost web URL only works on
 * this Mac, so its host is swapped for the LAN address; any other host is kept as is.
 */
export const lanJoinUrl = (webUrl: string, roomId: string, lanAddress: string | null): string | null => {
  let url: URL;
  try {
    url = new URL(webUrl);
  } catch {
    return null;
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    if (!lanAddress) return null;
    url.hostname = lanAddress;
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/room/${roomId}`;
  return url.toString();
};
