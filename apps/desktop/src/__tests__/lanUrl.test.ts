// The LAN link is what people type into their phones; picking a Docker bridge or VPN
// address instead of the Wi-Fi one gives a link that silently never loads.

import { describe, expect, it } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { findLanAddress, lanJoinUrl } from "../lanUrl";

const v4 = (address: string, internal = false) =>
  ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as NetworkInterfaceInfo;

describe("findLanAddress", () => {
  it("prefers the Wi-Fi/Ethernet interface over bridges and tunnels", () => {
    expect(
      findLanAddress({
        lo0: [v4("127.0.0.1", true)],
        bridge100: [v4("192.168.64.1")],
        utun4: [v4("10.8.0.2")],
        en0: [v4("192.168.1.111")],
      })
    ).toBe("192.168.1.111");
  });

  it("ignores public addresses", () => {
    expect(findLanAddress({ en0: [v4("203.0.113.5")] })).toBeNull();
  });
});

describe("lanJoinUrl", () => {
  it("swaps localhost for the LAN address", () => {
    expect(lanJoinUrl("http://localhost:3000", "123456", "192.168.1.111")).toBe(
      "http://192.168.1.111:3000/room/123456"
    );
  });

  it("keeps a real hostname as is", () => {
    expect(lanJoinUrl("https://music.example.com/", "123456", "192.168.1.111")).toBe(
      "https://music.example.com/room/123456"
    );
  });
});
