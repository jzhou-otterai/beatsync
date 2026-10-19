// The chunker's timestamps decide where every receiver places audio. If they're
// derived from jittery pipe-read times instead of sample counts, receivers hear
// clicks; if they never re-anchor, a sleep/wake leaves the room seconds behind.

import { decodeLiveAudioFrame } from "@beatsync/shared";
import { describe, expect, it } from "bun:test";
import { PcmChunker } from "../pcmChunker";

const SAMPLE_RATE = 48000;
const CHUNK_FRAMES = 960; // 20ms
const pcm = (frames: number) => Buffer.alloc(frames * 4); // stereo s16le

const makeChunker = (clock: { now: number }) =>
  new PcmChunker({
    streamId: 1,
    sampleRate: SAMPLE_RATE,
    channels: 2,
    latencyMs: 400,
    serverNow: () => clock.now,
    chunkFrames: CHUNK_FRAMES,
  });

describe("PcmChunker", () => {
  it("stamps frames contiguously by sample count despite bursty, jittery reads", () => {
    const clock = { now: 1_000_000 };
    const chunker = makeChunker(clock);
    const playAts: number[] = [];

    // Feed 2s of audio in odd-sized reads with ±8ms timing jitter
    for (let i = 0; i < 200; i++) {
      clock.now += 10 + (i % 3 === 0 ? 8 : i % 3 === 1 ? -8 : 0);
      for (const f of chunker.push(pcm(480))) playAts.push(decodeLiveAudioFrame(f)!.playAtServerTime);
    }

    expect(playAts.length).toBe(100);
    for (let i = 1; i < playAts.length; i++) {
      expect(playAts[i] - playAts[i - 1]).toBeCloseTo(20, 6);
    }
    expect(chunker.reanchors).toBe(0);
  });

  it("re-anchors after a capture stall so the stream stays near real time", () => {
    const clock = { now: 1_000_000 };
    const chunker = makeChunker(clock);

    clock.now += 20;
    const first = decodeLiveAudioFrame(chunker.push(pcm(CHUNK_FRAMES))[0])!;

    // Mac sleeps for 30s, then capture resumes
    clock.now += 30_000;
    const after = decodeLiveAudioFrame(chunker.push(pcm(CHUNK_FRAMES))[0])!;

    expect(chunker.reanchors).toBe(1);
    // Played ~latency after capture, not 20ms after the pre-sleep frame
    expect(after.playAtServerTime - clock.now).toBeCloseTo(400 - 20, 0);
    expect(after.playAtServerTime - first.playAtServerTime).toBeGreaterThan(29_000);
    expect(after.seq).toBe(first.seq + 1);
  });

  // A Bluetooth listener raises the buffer mid-stream: frames from then on must be
  // stamped that much later, or that listener keeps getting audio too late to play
  it("moves timestamps by the change when the buffer changes mid-stream", () => {
    const clock = { now: 1_000_000 };
    const chunker = makeChunker(clock);
    const playAt = () => {
      clock.now += 20;
      return decodeLiveAudioFrame(chunker.push(pcm(CHUNK_FRAMES))[0])!.playAtServerTime;
    };

    playAt();
    const before = playAt();
    chunker.setLatency(650);
    const after = playAt();

    expect(after - before).toBeCloseTo(20 + 250, 0);
  });
});
