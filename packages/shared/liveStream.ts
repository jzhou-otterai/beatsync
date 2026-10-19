/**
 * Live stream binary framing.
 *
 * A live broadcaster (e.g. the desktop app capturing macOS system audio) sends
 * PCM chunks as binary WebSocket frames. The server relays them untouched to the
 * rest of the room. Each frame carries the server time at which its first sample
 * should leave the speakers, so receivers schedule it with the same NTP clock
 * offset they already use for scheduled play/pause.
 *
 * Layout (little-endian, 24-byte header followed by payload):
 *   0  u8   magic (0xB5)
 *   1  u8   version
 *   2  u8   channels
 *   3  u8   codec (0 = PCM s16le interleaved)
 *   4  u32  streamId
 *   8  u32  seq
 *   12 f64  playAtServerTime (epoch ms)
 *   20 u32  sampleRate
 *   24 ...  payload
 */

export const LIVE_STREAM_CONSTANTS = {
  MAGIC: 0xb5,
  VERSION: 1,
  HEADER_BYTES: 24,
  CODEC_PCM_S16LE: 0,
  // Frames per chunk sent by the broadcaster (20ms at 48kHz)
  CHUNK_FRAMES: 960,
  DEFAULT_LATENCY_MS: 400,
  MIN_LATENCY_MS: 100,
  MAX_LATENCY_MS: 3000,
  // Upper bound on a single frame so a misbehaving client can't flood the room
  MAX_FRAME_BYTES: 64 * 1024,
} as const;

export interface LiveAudioFrameHeader {
  channels: number;
  codec: number;
  streamId: number;
  seq: number;
  playAtServerTime: number;
  sampleRate: number;
}

export interface LiveAudioFrame extends LiveAudioFrameHeader {
  /** Interleaved PCM samples */
  samples: Int16Array;
}

export const encodeLiveAudioFrame = (header: LiveAudioFrameHeader, samples: Int16Array): Uint8Array<ArrayBuffer> => {
  const { HEADER_BYTES, MAGIC, VERSION } = LIVE_STREAM_CONSTANTS;
  const out = new Uint8Array(HEADER_BYTES + samples.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, MAGIC);
  view.setUint8(1, VERSION);
  view.setUint8(2, header.channels);
  view.setUint8(3, header.codec);
  view.setUint32(4, header.streamId, true);
  view.setUint32(8, header.seq, true);
  view.setFloat64(12, header.playAtServerTime, true);
  view.setUint32(20, header.sampleRate, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), HEADER_BYTES);
  return out;
};

/** Parse only the header — cheap enough for the server to validate frames it relays. */
export const decodeLiveAudioFrameHeader = (bytes: Uint8Array): LiveAudioFrameHeader | null => {
  const { HEADER_BYTES, MAGIC, VERSION } = LIVE_STREAM_CONSTANTS;
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MAGIC || view.getUint8(1) !== VERSION) return null;
  const header: LiveAudioFrameHeader = {
    channels: view.getUint8(2),
    codec: view.getUint8(3),
    streamId: view.getUint32(4, true),
    seq: view.getUint32(8, true),
    playAtServerTime: view.getFloat64(12, true),
    sampleRate: view.getUint32(20, true),
  };
  if (header.channels < 1 || header.channels > 2 || header.sampleRate < 8000 || header.sampleRate > 192000) {
    return null;
  }
  return header;
};

export const decodeLiveAudioFrame = (bytes: Uint8Array): LiveAudioFrame | null => {
  const header = decodeLiveAudioFrameHeader(bytes);
  if (!header || header.codec !== LIVE_STREAM_CONSTANTS.CODEC_PCM_S16LE) return null;
  const payloadBytes = bytes.byteLength - LIVE_STREAM_CONSTANTS.HEADER_BYTES;
  if (payloadBytes % (2 * header.channels) !== 0) return null;
  // Copy so the Int16Array is aligned regardless of the source offset
  const payload = bytes.slice(LIVE_STREAM_CONSTANTS.HEADER_BYTES);
  return { ...header, samples: new Int16Array(payload.buffer, 0, payloadBytes / 2) };
};
