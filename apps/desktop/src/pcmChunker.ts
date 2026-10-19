import { encodeLiveAudioFrame, LIVE_STREAM_CONSTANTS } from "@beatsync/shared";

// Re-anchor the sample clock if it wanders this far from wall-clock expectations
const REANCHOR_THRESHOLD_MS = 25;
// Smoothing for the drift estimate — pipe reads arrive in bursts, so single readings are noisy
const DRIFT_EMA_ALPHA = 0.02;

export interface PcmChunkerOptions {
  streamId: number;
  sampleRate: number;
  channels: number;
  latencyMs: number;
  /** Current server time in epoch ms */
  serverNow: () => number;
  chunkFrames?: number;
}

/**
 * Slices raw s16le PCM from the capture helper into fixed-size frames and stamps each
 * with the server time it should play at.
 *
 * Timestamps advance by sample count (not wall-clock reads), so frames tile the
 * timeline exactly and receivers can schedule them gaplessly. A smoothed drift
 * estimate against the server clock catches the slow divergence between the Mac's
 * audio clock and its system clock, and big discontinuities like sleep/wake.
 */
export class PcmChunker {
  private pending: Buffer = Buffer.alloc(0);
  private anchorServerTime: number | null = null;
  private framesSinceAnchor = 0;
  private seq = 0;
  private driftEmaMs = 0;
  private readonly bytesPerFrame: number;
  private readonly chunkFrames: number;
  reanchors = 0;

  constructor(private readonly opts: PcmChunkerOptions) {
    this.bytesPerFrame = 2 * opts.channels;
    this.chunkFrames = opts.chunkFrames ?? LIVE_STREAM_CONSTANTS.CHUNK_FRAMES;
  }

  /**
   * Change the buffer mid-stream. Re-anchors, so listeners resync once (a short gap or
   * skip) and then play the same stream with the new lead.
   */
  setLatency(latencyMs: number): void {
    this.opts.latencyMs = latencyMs;
    this.anchorServerTime = null;
  }

  /** Feed raw PCM; returns encoded frames ready to send */
  push(data: Buffer): Uint8Array<ArrayBuffer>[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const chunkBytes = this.chunkFrames * this.bytesPerFrame;
    const frames: Uint8Array<ArrayBuffer>[] = [];

    while (this.pending.length >= chunkBytes) {
      const chunk = this.pending.subarray(0, chunkBytes);
      this.pending = this.pending.subarray(chunkBytes);
      frames.push(this.stamp(chunk));
    }
    return frames;
  }

  private stamp(chunk: Buffer): Uint8Array<ArrayBuffer> {
    const { sampleRate, channels, latencyMs, streamId, serverNow } = this.opts;
    const chunkDurationMs = (this.chunkFrames / sampleRate) * 1000;
    // This chunk's first sample was captured roughly one chunk ago
    const expected = serverNow() - chunkDurationMs + latencyMs;

    if (this.anchorServerTime === null) {
      this.anchor(expected);
    } else {
      const sampleClockTime = this.anchorServerTime + (this.framesSinceAnchor / sampleRate) * 1000;
      const drift = sampleClockTime - expected;
      this.driftEmaMs += DRIFT_EMA_ALPHA * (drift - this.driftEmaMs);
      // A huge single jump (sleep/wake, capture stall) re-anchors immediately
      if (Math.abs(this.driftEmaMs) > REANCHOR_THRESHOLD_MS || Math.abs(drift) > 500) {
        this.reanchors++;
        this.anchor(expected);
      }
    }

    const playAtServerTime = this.anchorServerTime! + (this.framesSinceAnchor / sampleRate) * 1000;
    this.framesSinceAnchor += this.chunkFrames;

    const samples = new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    return encodeLiveAudioFrame(
      {
        channels,
        codec: 0,
        streamId,
        seq: this.seq++,
        playAtServerTime,
        sampleRate,
      },
      samples
    );
  }

  private anchor(serverTime: number): void {
    this.anchorServerTime = serverTime;
    this.framesSinceAnchor = 0;
    this.driftEmaMs = 0;
  }
}
