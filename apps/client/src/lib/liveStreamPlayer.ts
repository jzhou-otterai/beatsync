import { audioContextManager } from "@/lib/audioContextManager";
import { getFilteredOutputLatencyMs, useGlobalStore } from "@/store/global";
import { decodeLiveAudioFrame, epochNow, type LiveAudioFrame } from "@beatsync/shared";

// Beyond this much scheduling error, jump instead of gently correcting (audible, but rare)
const HARD_RESYNC_THRESHOLD_S = 0.04;
// Max playback-rate deviation used to drift back into sync (±0.3% ≈ 5 cents, inaudible)
const MAX_RATE_CORRECTION = 0.003;
// Frames that would start sooner than this are dropped rather than played late
const MIN_SCHEDULE_AHEAD_S = 0.005;

/**
 * Plays a live PCM stream relayed by the server (e.g. a Mac's system audio).
 *
 * Every frame carries the server time its first sample should be heard. We map that
 * onto the AudioContext clock with the same NTP offset + nudge + outputLatency
 * compensation used for scheduled file playback, then schedule frames back-to-back.
 * Small clock drift between sender and receiver is absorbed by nudging playbackRate
 * rather than jumping, so the stream stays gapless.
 */
class LiveStreamPlayer {
  private streamId: number | null = null;
  private nextStartTime: number | null = null;
  private lastSeq = -1;
  private activeSources = new Set<AudioBufferSourceNode>();
  stats = { received: 0, played: 0, droppedLate: 0, resyncs: 0, lastErrorMs: 0 };

  handleBinaryMessage(data: ArrayBuffer): void {
    const frame = decodeLiveAudioFrame(new Uint8Array(data));
    if (!frame) return;
    this.stats.received++;

    const { liveStream, isInitingSystem } = useGlobalStore.getState();
    // Ignore stray frames from a previous/unknown stream, and play nothing until
    // the user has started the audio system (AudioContext needs a user gesture)
    if (!liveStream || liveStream.streamId !== frame.streamId || isInitingSystem) return;
    if (!audioContextManager.isReady()) return;

    if (this.streamId !== frame.streamId || frame.seq <= this.lastSeq) {
      if (this.streamId !== frame.streamId) this.reset(frame.streamId);
      else return; // duplicate / out-of-order
    }
    this.lastSeq = frame.seq;

    this.schedule(frame);
  }

  private targetAudioTime(playAtServerTime: number): number {
    const { offsetEstimate, nudgeOffsetMs } = useGlobalStore.getState();
    const waitMs = playAtServerTime - (epochNow() + offsetEstimate + nudgeOffsetMs) - getFilteredOutputLatencyMs();
    return audioContextManager.perfTimeToAudioTime(performance.now() + waitMs);
  }

  private schedule(frame: LiveAudioFrame): void {
    const ctx = audioContextManager.getContext();
    const frameCount = frame.samples.length / frame.channels;
    const target = this.targetAudioTime(frame.playAtServerTime);

    let startAt = this.nextStartTime ?? target;
    let error = startAt - target; // > 0: we're running late, < 0: early
    if (Math.abs(error) > HARD_RESYNC_THRESHOLD_S) {
      if (this.nextStartTime !== null) this.stats.resyncs++;
      startAt = target;
      error = 0;
    }
    this.stats.lastErrorMs = error * 1000;

    if (startAt < ctx.currentTime + MIN_SCHEDULE_AHEAD_S) {
      // Network delivered this too late to play on time — skip it and re-anchor on the next one
      this.stats.droppedLate++;
      this.nextStartTime = null;
      return;
    }

    const buffer = ctx.createBuffer(frame.channels, frameCount, frame.sampleRate);
    for (let ch = 0; ch < frame.channels; ch++) {
      const out = buffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        out[i] = frame.samples[i * frame.channels + ch] / 32768;
      }
    }

    // Proportional correction: running late → play slightly faster to catch up
    const rate = 1 + Math.max(-MAX_RATE_CORRECTION, Math.min(MAX_RATE_CORRECTION, error));

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(audioContextManager.getInputNode());
    source.onended = () => {
      source.disconnect();
      this.activeSources.delete(source);
    };
    source.start(startAt);
    this.activeSources.add(source);
    this.stats.played++;

    this.nextStartTime = startAt + buffer.duration / rate;
  }

  private reset(streamId: number | null): void {
    this.streamId = streamId;
    this.nextStartTime = null;
    this.lastSeq = -1;
  }

  stop(): void {
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // Already stopped
      }
    }
    this.activeSources.clear();
    this.reset(null);
  }
}

export const liveStreamPlayer = new LiveStreamPlayer();
