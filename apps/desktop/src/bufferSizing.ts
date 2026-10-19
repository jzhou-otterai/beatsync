/**
 * Room for the network on top of the slowest listener's own output delay: frames have to
 * reach that device and still be early enough for it to play them that much ahead.
 * Capture, chunking and scheduling already use ~100ms of the buffer, and phones on Wi-Fi
 * see jitter spikes, so this leaves ~150ms of real margin.
 */
export const LISTENER_HEADROOM_MS = 250;
export const MAX_BUFFER_MS = 2000;
/** Smaller changes aren't worth the short gap a retarget causes */
export const MIN_BUFFER_CHANGE_MS = 25;

/**
 * The buffer the stream actually uses: the one set in the app, raised when a listener
 * plays early to make up for its own delay (e.g. Bluetooth headphones on a phone), so
 * that device still gets each frame in time. Drops back once that listener leaves.
 */
export const effectiveBufferMs = (configuredMs: number, maxListenerCompensationMs: number): number =>
  Math.round(Math.min(MAX_BUFFER_MS, Math.max(configuredMs, maxListenerCompensationMs + LISTENER_HEADROOM_MS)));
