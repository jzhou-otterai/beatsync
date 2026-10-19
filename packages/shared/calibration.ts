/**
 * Acoustic timing calibration.
 *
 * Some outputs add delay nobody reports: an iPhone playing through a Bluetooth speaker
 * says its output latency is ~20ms when the speaker is really ~200ms behind. The desktop
 * app measures it instead: it plays a short reference chirp on the Mac's own speakers,
 * asks one listener to play the same chirp CHIRP_GAP_MS later (each scheduled with its
 * normal timing), and listens with the Mac's microphone. How far the listener's chirp
 * lands from CHIRP_GAP_MS after the Mac's is that listener's timing error. Measuring the
 * gap between two sounds on one recording cancels out the microphone's own delay.
 */

export const CALIBRATION_CONSTANTS = {
  CHIRP_MS: 60,
  CHIRP_START_HZ: 2000,
  CHIRP_END_HZ: 7000,
  /** Kept moderate: it plays over whatever is streaming */
  CHIRP_GAIN: 0.35,
  /** The listener's chirp is scheduled this long after the Mac's reference chirp */
  CHIRP_GAP_MS: 600,
  /** Corrections a listener accepts, per round and in total */
  MAX_CORRECTION_MS: 1000,
} as const;

/** A Hann-windowed linear sweep: sharp correlation peak, easy to pick out over music */
export const generateChirp = (sampleRate: number): Float32Array<ArrayBuffer> => {
  const { CHIRP_MS, CHIRP_START_HZ, CHIRP_END_HZ, CHIRP_GAIN } = CALIBRATION_CONSTANTS;
  const n = Math.round((CHIRP_MS / 1000) * sampleRate);
  const duration = n / sampleRate;
  const sweepRate = (CHIRP_END_HZ - CHIRP_START_HZ) / duration;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (CHIRP_START_HZ * t + 0.5 * sweepRate * t * t);
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = CHIRP_GAIN * window * Math.sin(phase);
  }
  return out;
};

export interface ChirpMatch {
  /** Sample index in the recording where the chirp starts */
  index: number;
  /** Peak correlation over the typical correlation level; ~4+ is a clear detection */
  confidence: number;
  /** Raw peak correlation: how loud the chirp was, comparable across searches of one recording */
  score: number;
}

/**
 * Matched filter: correlate the recording with the chirp and return the strongest
 * match starting within [from, to) samples, or null if nothing stands out.
 */
export const findChirp = (
  recording: Float32Array,
  chirp: Float32Array,
  from = 0,
  to = recording.length - chirp.length,
  minConfidence = 4
): ChirpMatch | null => {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(recording.length - chirp.length, Math.floor(to));
  if (end <= start) return null;

  const scores = new Float32Array(end - start);
  let best = -1;
  let bestScore = 0;
  for (let i = start; i < end; i++) {
    let sum = 0;
    for (let j = 0; j < chirp.length; j++) sum += recording[i + j] * chirp[j];
    const score = Math.abs(sum);
    scores[i - start] = score;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || bestScore === 0) return null;

  // Typical level: median correlation away from the peak (music, room noise). Exact
  // silence doesn't count: a microphone that just opened delivers zeros for a while
  const guard = chirp.length;
  const background: number[] = [];
  for (let k = 0; k < scores.length; k += 4) {
    if (Math.abs(start + k - best) > guard && scores[k] > 0) background.push(scores[k]);
  }
  background.sort((a, b) => a - b);
  const typical = background.length ? background[Math.floor(background.length / 2)] : 0;
  const confidence = typical > 0 ? bestScore / typical : Infinity;
  return confidence >= minConfidence ? { index: best, confidence, score: bestScore } : null;
};
