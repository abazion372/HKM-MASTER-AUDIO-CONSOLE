/**
 * AudioWorkletProcessor that captures post-DSP console output frames and posts
 * 480-frame (10ms @ 48kHz) interleaved Float32 blocks for native WASAPI RAW
 * output. Channels default to 2 (classic stereo master tap); the v2 per-jack
 * engine arms 4..32 channels via processorOptions so each discrete jack pair
 * of a 5.1/7.1/pro card is carried in its native stream position.
 * Automatically resamples to 48 kHz whenever AudioContext sampleRate differs
 * from 48000 Hz.
 */
class RawOutputTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.blockFrames = 480;
    const requested =
      options && options.processorOptions ? Number(options.processorOptions.channels) : NaN;
    this.channels = Number.isFinite(requested)
      ? Math.max(2, Math.min(32, Math.round(requested)))
      : 2;
    this.interleaved = new Float32Array(this.blockFrames * this.channels);
    this.cursor = 0;
    this.inputSampleRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    this.outputSampleRate = 48000;
    this.stepIn = this.inputSampleRate / this.outputSampleRate;
    this.srcPhase = 0;
    this.prev = new Float32Array(this.channels);
    this.hasPrev = false;
    this.frame = new Float32Array(this.channels);
  }

  /** Commit the current frame (this.frame) into the interleaved block. */
  emitFrame() {
    const base = this.cursor * this.channels;
    for (let c = 0; c < this.channels; c++) {
      this.interleaved[base + c] = this.frame[c];
    }
    this.cursor += 1;
    if (this.cursor >= this.blockFrames) {
      const copy = new Float32Array(this.interleaved);
      this.port.postMessage(copy.buffer, [copy.buffer]);
      this.cursor = 0;
    }
  }

  /** Gather input frame `i` into this.frame (missing channels mirror CH 0). */
  readFrame(input, i) {
    const primary = input && input[0] ? input[0] : null;
    for (let c = 0; c < this.channels; c++) {
      const arr = input && input[c] ? input[c] : primary;
      this.frame[c] = arr ? arr[i] : 0;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const primary = input && input[0] ? input[0] : null;
    const frames = primary
      ? primary.length
      : output && output[0]
        ? output[0].length
        : 128;

    // Keep graph downstream alive with silent pass (monitorGain is muted while RAW mode runs)
    if (output) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
    }

    if (Math.abs(this.stepIn - 1) < 1e-6) {
      for (let i = 0; i < frames; i++) {
        this.readFrame(input, i);
        this.emitFrame();
      }
      return true;
    }

    if (!this.hasPrev) {
      this.readFrame(input, 0);
      this.prev.set(this.frame);
      this.hasPrev = true;
    }

    while (this.srcPhase < frames) {
      const idx0 = Math.floor(this.srcPhase);
      const frac = this.srcPhase - idx0;
      const idx1 = Math.min(frames - 1, idx0 + 1);
      // Linear interpolation per channel between idx0 (or the carried prev
      // frame when idx0 < 0) and idx1.
      for (let c = 0; c < this.channels; c++) {
        const arr = input && input[c] ? input[c] : input && input[0] ? input[0] : null;
        const v0 = idx0 < 0 ? this.prev[c] : arr ? arr[idx0] : 0;
        const v1 = arr ? arr[idx1] : 0;
        this.frame[c] = v0 + (v1 - v0) * frac;
      }
      this.emitFrame();
      this.srcPhase += this.stepIn;
    }

    this.srcPhase -= frames;
    if (frames > 0) {
      this.readFrame(input, frames - 1);
      this.prev.set(this.frame);
    }

    return true;
  }
}

registerProcessor('raw-output-tap-processor', RawOutputTapProcessor);
