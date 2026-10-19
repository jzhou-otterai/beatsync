// @ts-check
// Hidden window that times listeners for the main process (src/listenerCalibration.ts):
// it records the Mac's microphone and plays the reference chirp on the Mac's speakers.
const api = /** @type {any} */ (window).calibration;

/** @type {AudioContext | null} */
let ctx = null;
/** @type {MediaStream | null} */
let stream = null;
/** Recorded batches, oldest first: { frame, samples } */
let batches = [];
const KEEP_SECONDS = 8;

const isBeatsync = (/** @type {string} */ label) => /beatsync/i.test(label);

const pickInput = async () => {
  const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let s = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  if (!isBeatsync(s.getAudioTracks()[0]?.label ?? "")) return s;
  // The Beatsync device is an input too (its loopback); use a real microphone
  s.getTracks().forEach((t) => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mic = devices.find((d) => d.kind === "audioinput" && d.deviceId !== "default" && !isBeatsync(d.label));
  if (!mic) throw new Error("No microphone found besides the Beatsync device");
  return navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: mic.deviceId } } });
};

/** The Mac's real speakers: where its own copy of the room plays, never the Beatsync device */
const pickOutput = async (/** @type {string | null} */ preferredName) => {
  const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  const named = preferredName && outputs.find((d) => d.label.includes(preferredName));
  const fallback = outputs.find((d) => d.deviceId !== "default" && !isBeatsync(d.label));
  const device = named || fallback;
  if (!device) throw new Error("No speakers found besides the Beatsync device");
  return device;
};

api.onStart(async (/** @type {{ outputDeviceName: string | null }} */ { outputDeviceName }) => {
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    stream = await pickInput();
    const output = await pickOutput(outputDeviceName);
    await /** @type {any} */ (ctx).setSinkId(output.deviceId);
    await ctx.audioWorklet.addModule("micWorklet.js");
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "mic-capture");
    // Only nodes that reach the destination get processed; keep it silent
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    batches = [];
    node.port.onmessage = (event) => {
      batches.push(event.data);
      const oldest = event.data.frame - KEEP_SECONDS * (ctx?.sampleRate ?? 48000);
      while (batches.length && batches[0].frame < oldest) batches.shift();
    };
    await ctx.resume();
    api.ready({ input: stream.getAudioTracks()[0]?.label ?? "", output: output.label, sampleRate: ctx.sampleRate });
  } catch (error) {
    api.error(String(error instanceof Error ? error.message : error));
  }
});

/** Context time at which a sound must start to be heard at `localEpochMs` (this machine's clock) */
const epochToContextTime = (/** @type {number} */ localEpochMs) => {
  const c = /** @type {AudioContext} */ (ctx);
  const ts = c.getOutputTimestamp();
  const perfMs = localEpochMs - performance.timeOrigin;
  return (ts.contextTime ?? 0) + (perfMs - (ts.performanceTime ?? 0)) / 1000;
};

/** Recorded samples covering [fromFrame, toFrame), or null if some are missing */
const slice = (/** @type {number} */ fromFrame, /** @type {number} */ toFrame) => {
  const out = new Float32Array(toFrame - fromFrame);
  let filled = 0;
  for (const { frame, samples } of batches) {
    const start = Math.max(frame, fromFrame);
    const end = Math.min(frame + samples.length, toFrame);
    if (end <= start) continue;
    out.set(samples.subarray(start - frame, end - frame), start - fromFrame);
    filled += end - start;
  }
  return filled >= out.length * 0.98 ? out : null;
};

api.onMeasure(
  async (
    /** @type {{ id: number, refAtLocalEpochMs: number, chirp: Float32Array, recordMs: number }} */ {
      id,
      refAtLocalEpochMs,
      chirp,
      recordMs,
    }
  ) => {
    const c = ctx;
    if (!c) return api.result({ id, error: "Microphone not started" });
    const rate = c.sampleRate;
    const at = epochToContextTime(refAtLocalEpochMs);
    if (at <= c.currentTime) return api.result({ id, error: "Reference chirp scheduled too late" });

    const buffer = c.createBuffer(1, chirp.length, rate);
    buffer.copyToChannel(chirp, 0);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    src.start(at);

    // Recording positions are context frames, so the reference chirp's start is known
    // exactly; anything heard is that, plus output, air and input delay
    const refFrame = Math.round(at * rate);
    const fromFrame = refFrame - Math.round(0.1 * rate);
    const toFrame = refFrame + Math.round((recordMs / 1000) * rate);
    const deadline = performance.now() + (at - c.currentTime) * 1000 + recordMs + 3000;
    for (;;) {
      const recording = slice(fromFrame, toFrame);
      if (recording) return api.result({ id, recording, refIndex: refFrame - fromFrame, sampleRate: rate });
      if (performance.now() > deadline) return api.result({ id, error: "Microphone recording stalled" });
      await new Promise((r) => setTimeout(r, 100));
    }
  }
);

api.onStop(() => {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close();
  ctx = null;
  batches = [];
});
