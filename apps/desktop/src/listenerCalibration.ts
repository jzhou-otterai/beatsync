import { CALIBRATION_CONSTANTS, findChirp, generateChirp } from "@beatsync/shared";
import type { MicRecording } from "./micCalibrator";

const { CHIRP_GAP_MS } = CALIBRATION_CONSTANTS;
/** Close enough: about a 15ms echo, below what ears pick out in music */
const DONE_WITHIN_MS = 15;
const MAX_ROUNDS = 3;
const MIC_WARMUP_MS = 1000;
/** Let a newly joined listener sync its clock and start audio first */
const JOIN_SETTLE_MS = 5000;
/** After a correction: the room's buffer may grow, re-anchoring the stream */
const AFTER_CORRECTION_MS = 4000;
/** How early (-) or late (+) a listener's chirp may land and still be found */
// iOS has over-reported Bluetooth delay by ~300ms, so listeners can be well early
const SEARCH_EARLY_MS = 450;
const SEARCH_LATE_MS = 900;
/**
 * A real listener chirp is a clear peak, comparable to the Mac's own. Music correlates
 * with the chirp too, and in a live room produced peaks around 1% of the reference's;
 * counting those would shift a device by hundreds of ms for nothing.
 */
const MIN_LISTENER_TO_REFERENCE = 0.05;
/**
 * Where the Mac's own chirp may land relative to its slot: output + air + input delay,
 * plus however far the browser's output timing is off (it has been ~200ms on some Macs)
 */
const REFERENCE_EARLY_MS = 50;
const REFERENCE_LATE_MS = 350;
/** Two detections closer than this are the same chirp (its correlation sidelobes) */
const SAME_CHIRP_MS = 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Detection strengths, for the calibration log */
interface Strengths {
  reference?: number;
  listener?: number;
}

export type ChirpMeasurement =
  | ({ kind: "measured"; errorMs: number } & Strengths)
  | ({ kind: "no-reference" } & Strengths) // the Mac didn't hear its own chirp: mic or speakers off
  | ({ kind: "not-heard" } & Strengths); // headphones, muted, out of earshot, or audio not started

/**
 * Where the listener's chirp landed relative to the Mac's reference chirp in one
 * recording: positive means the listener plays late. Pure, so it can be tested.
 *
 * The two chirps are the two strongest in the recording, and the Mac's is the earlier
 * one. Which is louder depends on where the devices sit, so loudness can't tell them
 * apart; but the listener is scheduled CHIRP_GAP_MS later and can't be that far early.
 */
export const measureChirpOffset = (rec: MicRecording, chirp: Float32Array): ChirpMeasurement => {
  const msToSamples = (ms: number) => Math.round((ms / 1000) * rec.sampleRate);
  const from = rec.refIndex - msToSamples(REFERENCE_EARLY_MS);
  const to = rec.refIndex + msToSamples(CHIRP_GAP_MS + SEARCH_LATE_MS);
  const first = findChirp(rec.recording, chirp, from, to);
  if (!first) return { kind: "no-reference" };

  const guard = msToSamples(SAME_CHIRP_MS);
  const before = findChirp(rec.recording, chirp, from, first.index - guard);
  const after = findChirp(rec.recording, chirp, first.index + guard, to);
  // Raw peak heights compare across searches; confidences (vs. each range's background) don't
  const second = before && (!after || before.score > after.score) ? before : after;

  const [mac, listener] = second && second.index < first.index ? [second, first] : [first, second];
  if (mac.index > rec.refIndex + msToSamples(REFERENCE_LATE_MS)) return { kind: "no-reference" };
  const strengths = { reference: round3(mac.score), listener: listener ? round3(listener.score) : undefined };
  if (!listener || listener.score < mac.score * MIN_LISTENER_TO_REFERENCE) {
    return { kind: "not-heard", ...strengths };
  }
  const errorMs = ((listener.index - mac.index) / rec.sampleRate) * 1000 - CHIRP_GAP_MS;
  if (errorMs < -SEARCH_EARLY_MS) return { kind: "not-heard", ...strengths };
  return { kind: "measured", errorMs, ...strengths };
};

export interface ListenerCalibrationOptions {
  serverNow: () => number;
  /** Server time minus this machine's clock */
  clockOffsetMs: () => number;
  sendChirp: (targetClientId: string, chirpId: number, playAtServerTime: number) => void;
  sendResult: (targetClientId: string, chirpId: number, correctionMs: number) => void;
  measure: (refAtLocalEpochMs: number, chirp: Float32Array, recordMs: number) => Promise<MicRecording>;
  sampleRate: () => Promise<number>;
  /** Done with the microphone for now */
  release: () => void;
  onNote: (message: string) => void;
  /** Each listener's progress, for the sync visualization */
  onResult?: (clientId: string, result: ListenerTimingResult) => void;
  /** One line per measurement, for diagnosing timing by ear */
  log: (line: string) => void;
}

/** Where a listener stands in being timed by ear */
export type ListenerTimingResult =
  | { state: "queued" } // waiting its turn (one listener at a time)
  | { state: "measuring"; round: number }
  | { state: "verified"; errorMs: number } // heard within DONE_WITHIN_MS of the Mac
  | { state: "corrected"; errorMs: number } // still off after MAX_ROUNDS; last correction not re-checked
  | { state: "not-heard" } // headphones, muted or out of earshot
  | { state: "failed"; message: string };

/** Within this, a listener counts as in sync by ear */
export const IN_SYNC_WITHIN_MS = DONE_WITHIN_MS;

/**
 * Times each listener that joins a live stream by ear: the Mac and the listener each
 * play a chirp, the Mac's microphone hears both, and the listener is told how far off
 * it was until it lands within DONE_WITHIN_MS. Covers delay browsers don't report,
 * like a phone playing through a Bluetooth speaker. Runs one listener at a time.
 */
export class ListenerCalibration {
  private known = new Set<string>();
  private queue: { clientId: string; username: string }[] = [];
  private running = false;
  private stopped = false;
  private chirpId = 0;

  constructor(private readonly opts: ListenerCalibrationOptions) {}

  /** The room's listeners changed; time any new ones */
  updateListeners(listeners: { clientId: string; username: string }[]): void {
    for (const listener of listeners) {
      if (this.known.has(listener.clientId)) continue;
      this.known.add(listener.clientId);
      setTimeout(() => this.enqueue(listener), JOIN_SETTLE_MS);
    }
    const present = new Set(listeners.map((l) => l.clientId));
    for (const id of this.known) if (!present.has(id)) this.known.delete(id);
  }

  /** Time everyone again, e.g. after a speaker was connected mid-session */
  recheck(listeners: { clientId: string; username: string }[]): void {
    for (const listener of listeners) this.enqueue(listener);
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.opts.release();
  }

  private enqueue(listener: { clientId: string; username: string }): void {
    if (this.stopped || !this.known.has(listener.clientId)) return;
    if (this.queue.some((q) => q.clientId === listener.clientId)) return;
    this.queue.push(listener);
    this.opts.onResult?.(listener.clientId, { state: "queued" });
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const listener = this.queue.shift()!;
        if (!this.known.has(listener.clientId)) continue;
        try {
          await this.calibrate(listener);
        } catch (error) {
          this.opts.onNote(`Couldn't time ${listener.username}: ${(error as Error).message}`);
          this.opts.onResult?.(listener.clientId, { state: "failed", message: (error as Error).message });
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped) this.opts.release();
    }
  }

  private async calibrate({ clientId, username }: { clientId: string; username: string }): Promise<void> {
    const chirp = generateChirp(await this.opts.sampleRate());
    // A microphone that just opened delivers silence for a moment
    await new Promise((r) => setTimeout(r, MIC_WARMUP_MS));
    let totalMs = 0;
    let lastErrorMs = 0;
    let verified = false;
    for (let round = 1; round <= MAX_ROUNDS && !this.stopped; round++) {
      this.opts.onResult?.(clientId, { state: "measuring", round });
      const chirpId = ++this.chirpId;
      // Enough lead for the request to arrive and for the listener's own compensation
      const refAtServer = this.opts.serverNow() + 1500;
      this.opts.sendChirp(clientId, chirpId, refAtServer + CHIRP_GAP_MS);
      const rec = await this.opts.measure(
        refAtServer - this.opts.clockOffsetMs(),
        chirp,
        CHIRP_GAP_MS + SEARCH_LATE_MS + 300
      );
      const result = measureChirpOffset(rec, chirp);
      this.opts.log(
        `${username} round ${round}: ${result.kind}` +
          (result.kind === "measured" ? ` ${Math.round(result.errorMs)} ms` : "") +
          ` (reference strength ${result.reference ?? "-"}, listener ${result.listener ?? "-"})`
      );
      if (result.kind === "no-reference") {
        throw new Error("the Mac's microphone didn't hear its own speakers");
      }
      if (result.kind === "not-heard") {
        this.opts.onNote(`${username} couldn't be heard by the Mac's microphone, so its timing wasn't checked`);
        this.opts.onResult?.(clientId, { state: "not-heard" });
        return;
      }
      const errorMs = Math.round(result.errorMs);
      lastErrorMs = errorMs;
      if (Math.abs(errorMs) <= DONE_WITHIN_MS) {
        verified = true;
        break;
      }
      totalMs += errorMs;
      this.opts.sendResult(clientId, chirpId, errorMs);
      await new Promise((r) => setTimeout(r, AFTER_CORRECTION_MS));
    }
    this.opts.onResult?.(
      clientId,
      verified ? { state: "verified", errorMs: lastErrorMs } : { state: "corrected", errorMs: lastErrorMs }
    );
    this.opts.onNote(
      totalMs === 0
        ? `${username} is in sync with this Mac`
        : `Synced ${username}: it was ${Math.abs(totalMs)} ms ${totalMs > 0 ? "behind" : "ahead"}`
    );
  }
}
