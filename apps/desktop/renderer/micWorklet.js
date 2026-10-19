// Collects microphone samples with their AudioContext frame position, in batches
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.count = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.count === 0) this.startFrame = currentFrame;
    this.buffer.set(channel, this.count);
    this.count += channel.length;
    if (this.count > this.buffer.length - 128) {
      this.port.postMessage({ frame: this.startFrame, samples: this.buffer.slice(0, this.count) });
      this.count = 0;
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
