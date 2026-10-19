// The buffer is what lets a Bluetooth listener play early. Too small and that device
// silently drops every frame as "late"; it should also never shrink below what the
// user chose, or exceed what the Mac's delay line holds.

import { describe, expect, it } from "bun:test";
import { effectiveBufferMs, LISTENER_HEADROOM_MS, MAX_BUFFER_MS } from "../bufferSizing";

describe("effectiveBufferMs", () => {
  it("grows to the slowest listener's delay plus headroom", () => {
    expect(effectiveBufferMs(300, 250)).toBe(250 + LISTENER_HEADROOM_MS);
  });

  it("keeps the configured buffer when it's already enough", () => {
    expect(effectiveBufferMs(450, 20)).toBe(450);
  });

  it("never exceeds the maximum buffer", () => {
    expect(effectiveBufferMs(300, 5000)).toBe(MAX_BUFFER_MS);
  });
});
