// The buffer is what lets a Bluetooth listener play early. If it doesn't grow by that
// listener's full delay, every frame reaches it too late and it plays nothing.

import { describe, expect, it } from "bun:test";
import { effectiveBufferMs, MAX_BUFFER_MS } from "../bufferSizing";

describe("effectiveBufferMs", () => {
  it("grows by the slowest listener's delay on top of the configured buffer", () => {
    expect(effectiveBufferMs(550, 290)).toBe(840);
  });

  it("is the configured buffer when nobody needs extra lead", () => {
    expect(effectiveBufferMs(450, 0)).toBe(450);
  });

  it("never exceeds the maximum buffer", () => {
    expect(effectiveBufferMs(300, 5000)).toBe(MAX_BUFFER_MS);
  });
});
