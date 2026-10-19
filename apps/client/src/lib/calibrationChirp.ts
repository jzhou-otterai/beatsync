import { audioContextManager } from "@/lib/audioContextManager";
import { serverTimeToAudioTime } from "@/lib/liveStreamPlayer";
import { generateChirp } from "@beatsync/shared";

/**
 * Play the calibration chirp so it's heard at `playAtServerTime`, with this device's
 * normal timing. The desktop app hears it through the Mac's microphone and reports how
 * far off it was (see packages/shared/calibration.ts).
 */
export const playCalibrationChirp = (playAtServerTime: number): void => {
  if (!audioContextManager.isReady()) return; // Audio not started yet: nothing to measure
  const ctx = audioContextManager.getContext();
  const samples = generateChirp(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples, 0);

  const startAt = serverTimeToAudioTime(playAtServerTime);
  if (startAt <= ctx.currentTime) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContextManager.getInputNode());
  source.onended = () => source.disconnect();
  source.start(startAt);
};
