import { epochNow, NTP_CONSTANTS, type NTPResponseMessageType } from "@beatsync/shared";

/** Clean probe pairs needed before the clock offset is trusted and audio can flow */
export const SYNC_MEASUREMENTS = NTP_CONSTANTS.MAX_MEASUREMENTS / 2;

interface Measurement {
  t0: number;
  t1: number;
  roundTripDelay: number;
  clockOffset: number;
}

/**
 * Server clock estimate — the same coded-probe (Huygens) NTP scheme the web client
 * uses (apps/client/src/utils/ntp.ts): probes go out in pairs a known gap apart,
 * pairs whose server-side gap doesn't match are discarded as queued, and the
 * offset comes from the lowest-RTT surviving measurement.
 */
export class ServerClock {
  private measurements: Measurement[] = [];
  private pendingFirst: { groupId: number; m: Measurement } | null = null;
  private nextGroupId = 0;

  offsetMs = 0;
  rttMs = 0;

  get isSynced(): boolean {
    return this.measurements.length >= SYNC_MEASUREMENTS;
  }

  get measurementCount(): number {
    return this.measurements.length;
  }

  /** Current server time in epoch ms */
  now(): number {
    return epochNow() + this.offsetMs;
  }

  reset(): void {
    this.measurements = [];
    this.pendingFirst = null;
    this.offsetMs = 0;
    this.rttMs = 0;
  }

  /** Send one probe pair via `send`. Returns after scheduling the second probe. */
  sendProbePair(send: (request: { t0: number; probeGroupId: number; probeGroupIndex: 0 | 1 }) => void): void {
    const probeGroupId = this.nextGroupId++;
    send({ t0: epochNow(), probeGroupId, probeGroupIndex: 0 });
    setTimeout(() => send({ t0: epochNow(), probeGroupId, probeGroupIndex: 1 }), NTP_CONSTANTS.PROBE_GAP_MS);
  }

  handleResponse(response: NTPResponseMessageType, t3 = epochNow()): void {
    const { t0, t1, t2, probeGroupId, probeGroupIndex } = response;
    const m: Measurement = {
      t0,
      t1,
      clockOffset: (t1 - t0 + (t2 - t3)) / 2,
      roundTripDelay: t3 - t0 - (t2 - t1),
    };

    if (probeGroupIndex === 0) {
      this.pendingFirst = { groupId: probeGroupId, m };
      return;
    }

    const first = this.pendingFirst;
    this.pendingFirst = null;
    if (!first || first.groupId !== probeGroupId) return;

    const gapDrift = Math.abs(m.t1 - first.m.t1 - (m.t0 - first.m.t0));
    if (gapDrift > NTP_CONSTANTS.PROBE_GAP_TOLERANCE_MS) return; // impure pair

    const best = first.m.roundTripDelay <= m.roundTripDelay ? first.m : m;
    this.measurements.push(best);
    if (this.measurements.length > NTP_CONSTANTS.MAX_MEASUREMENTS) this.measurements.shift();

    let minRtt = Infinity;
    for (const x of this.measurements) {
      if (x.roundTripDelay < minRtt) {
        minRtt = x.roundTripDelay;
        this.offsetMs = x.clockOffset;
      }
    }
    this.rttMs = this.measurements.reduce((sum, x) => sum + x.roundTripDelay, 0) / this.measurements.length;
  }
}
