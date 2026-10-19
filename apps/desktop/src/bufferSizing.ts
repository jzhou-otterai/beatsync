export const MAX_BUFFER_MS = 2000;
/** Smaller changes aren't worth the short gap a retarget causes */
export const MIN_BUFFER_CHANGE_MS = 25;

/**
 * The buffer the stream actually uses. The configured buffer is what a device with no
 * output delay needs (capture, network, scheduling). A listener that plays early to
 * make up for its own delay (e.g. a phone on a Bluetooth speaker) needs that much more
 * lead on top, or every frame reaches it too late to play and it goes silent. So the
 * buffer grows by the slowest listener's delay, and drops back once it leaves.
 */
export const effectiveBufferMs = (configuredMs: number, maxListenerCompensationMs: number): number =>
  Math.round(Math.min(MAX_BUFFER_MS, configuredMs + Math.max(0, maxListenerCompensationMs)));
