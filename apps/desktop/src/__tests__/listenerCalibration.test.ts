// The measured offset is applied straight to a listener's timing. A wrong peak (music
// mistaken for the chirp) would throw that device hundreds of ms out, and a chirp the
// Mac can't hear must be reported as such rather than as "in sync".

import { CALIBRATION_CONSTANTS, generateChirp } from "@beatsync/shared";
import { describe, expect, it } from "bun:test";
import { measureChirpOffset } from "../listenerCalibration";

const RATE = 48000;
const chirp = generateChirp(RATE);
const ms = (value: number) => Math.round((value / 1000) * RATE);

// Seeded noise so the test is repeatable
let seed = 1;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** ~1.8s of "music" (chords and noise), the Mac's chirp, and optionally the listener's */
const room = (opts: { listenerLateMs: number | null; listenerGain: number; macLateMs?: number }) => {
  const recording = new Float32Array(ms(1900));
  for (let i = 0; i < recording.length; i++) {
    const t = i / RATE;
    recording[i] =
      0.2 * Math.sin(2 * Math.PI * 220 * t) +
      0.15 * Math.sin(2 * Math.PI * 330 * t) +
      0.1 * Math.sin(2 * Math.PI * 3000 * t) +
      0.05 * random();
  }
  const refIndex = ms(100);
  const add = (at: number, gain: number) => {
    for (let j = 0; j < chirp.length; j++) recording[at + j] += gain * chirp[j];
  };
  // Mac speakers, heard after ~25ms of output/air/input delay
  const macAt = refIndex + ms(opts.macLateMs ?? 25);
  add(macAt, 1);
  if (opts.listenerLateMs !== null)
    add(macAt + ms(CALIBRATION_CONSTANTS.CHIRP_GAP_MS + opts.listenerLateMs), opts.listenerGain);
  return { recording, refIndex, sampleRate: RATE };
};

describe("measureChirpOffset", () => {
  it("measures a quieter Bluetooth speaker playing 190ms late over music", () => {
    const result = measureChirpOffset(room({ listenerLateMs: 190, listenerGain: 0.3 }), chirp);
    expect(result.kind).toBe("measured");
    if (result.kind === "measured") expect(result.errorMs).toBeCloseTo(190, 0);
  });

  // A phone that over-reports its Bluetooth delay plays early, and next to the Mac it's
  // louder than the Mac's own speakers
  it("measures an early listener that's louder than the Mac", () => {
    const result = measureChirpOffset(room({ listenerLateMs: -208, listenerGain: 1.5 }), chirp);
    expect(result.kind).toBe("measured");
    if (result.kind === "measured") expect(result.errorMs).toBeCloseTo(-208, 0);
  });

  // The Mac's own output timing can be ~200ms off its slot; the gap between the two
  // chirps is what counts
  it("measures relative to the Mac's chirp even when that lands late", () => {
    const result = measureChirpOffset(room({ listenerLateMs: -208, listenerGain: 1.5, macLateMs: 200 }), chirp);
    expect(result.kind).toBe("measured");
    if (result.kind === "measured") expect(result.errorMs).toBeCloseTo(-208, 0);
  });

  // A microphone that just opened delivers exact zeros, here for most of the recording
  it("measures through a recording that's mostly silence", () => {
    const rec = room({ listenerLateMs: 190, listenerGain: 0.3 });
    const recording = new Float32Array(ms(2500) + rec.recording.length);
    recording.set(rec.recording, ms(2500));
    const result = measureChirpOffset({ ...rec, recording, refIndex: rec.refIndex + ms(2500) }, chirp);
    expect(result.kind).toBe("measured");
    if (result.kind === "measured") expect(result.errorMs).toBeCloseTo(190, 0);
  });

  // Some Macs' microphones deliver exact zeros between sounds
  it("measures in a recording that's pure silence apart from the two chirps", () => {
    const recording = new Float32Array(ms(1900));
    const refIndex = ms(100);
    recording.set(chirp, refIndex + ms(20));
    recording.set(
      chirp.map((v) => v * 0.6),
      refIndex + ms(20 + CALIBRATION_CONSTANTS.CHIRP_GAP_MS - 208)
    );
    const result = measureChirpOffset({ recording, refIndex, sampleRate: RATE }, chirp);
    expect(result.kind).toBe("measured");
    if (result.kind === "measured") expect(result.errorMs).toBeCloseTo(-208, 0);
  });

  // From a real room: iOS reported 290ms for a Bluetooth speaker that's far quicker
  it("measures a listener 356ms early", () => {
    const result = measureChirpOffset(room({ listenerLateMs: -356, listenerGain: 0.17, macLateMs: 80 }), chirp);
    expect(result.kind).toBe("measured");
    if (result.kind === "measured") expect(result.errorMs).toBeCloseTo(-356, 0);
  });

  it("measures a listener playing early", () => {
    const result = measureChirpOffset(room({ listenerLateMs: -120, listenerGain: 0.5 }), chirp);
    expect(result.kind).toBe("measured");
    if (result.kind === "measured") expect(result.errorMs).toBeCloseTo(-120, 0);
  });

  it("doesn't mistake music for a faint listener chirp", () => {
    expect(measureChirpOffset(room({ listenerLateMs: 190, listenerGain: 0.005 }), chirp).kind).toBe("not-heard");
  });

  it("reports a listener the microphone can't hear instead of guessing", () => {
    expect(measureChirpOffset(room({ listenerLateMs: null, listenerGain: 0 }), chirp).kind).toBe("not-heard");
  });
});
