// A phone on Bluetooth plays a few hundred ms late. If its reported delay is thrown away,
// it stays audibly behind the room; if bogus readings are trusted, it jumps far ahead.

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { audioContextManager } from "@/lib/audioContextManager";
import { getFilteredOutputLatencyMs } from "@/store/global";

const reportOutputLatency = (seconds: number) =>
  spyOn(audioContextManager, "getContext").mockReturnValue({ outputLatency: seconds } as AudioContext);

describe("getFilteredOutputLatencyMs", () => {
  afterEach(() => {
    mock.restore();
  });

  it("uses a Bluetooth delay the browser reports, rounded so jitter doesn't move the room", () => {
    reportOutputLatency(0.183);
    expect(getFilteredOutputLatencyMs()).toBe(180);
  });

  it("ignores implausible readings", () => {
    reportOutputLatency(0.648);
    expect(getFilteredOutputLatencyMs()).toBe(0);
  });
});
