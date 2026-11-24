/**
 * HKM Audio System — FX AudioWorklet processors.
 *
 * Loaded once per AudioContext via `ctx.audioWorklet.addModule('/fx-worklets.js')`.
 * Processors follow the 128-frame render-quantum contract.
 *
 * 1. fx-gate-processor — Boss NS-2 style noise gate with envelope-follower
 *    state machine (attack / hold / release). Envelope detection and VCA must
 *    live in the worklet: main-thread AnalyserNode metering is far too laggy
 *    for click-free gating.
 *
 * 2. fx-sub-octave-processor — classic monophonic octave-divider (flip-flop
 *    toggling polarity at zero crossings halves the fundamental, POG/octaver
 *    "Oct Down" voice). Cheap, sample-accurate, glitch-tolerant.
 */

class FxGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -55, minValue: -90, maxValue: -10, automationRate: 'k-rate' },
      { name: 'floor', defaultValue: -40, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 2, minValue: 1, maxValue: 20, automationRate: 'k-rate' }, // ms
      { name: 'release', defaultValue: 120, minValue: 20, maxValue: 500, automationRate: 'k-rate' }, // ms
    ];
  }

  constructor() {
    super();
    this.env = 0; // smoothed envelope (linear abs-mean)
    this.gain = 0; // current VCA gain (0..1)
    this.open = false;
    this.holdSamples = 0;
    this.sampleRate = sampleRate || 48000;
  }

  process(_inputs, outputs, parameters) {
    const input = _inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      // No input: keep envelope decaying, render silence.
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const n = input[0].length;
    const threshold = parameters.threshold[0];
    const floorLin = Math.pow(10, parameters.floor[0] / 20);
    // Per-sample ramp deltas for click-free transitions.
    const attackStep = 128 / (this.sampleRate * (parameters.attack[0] / 1000));
    const releaseStep = 128 / (this.sampleRate * (parameters.release[0] / 1000));
    const holdSamples = Math.round(0.01 * this.sampleRate); // 10 ms hold

    // Envelope: abs-max of the block (fast) smoothed 2:1 up/down.
    let blockPeak = 0;
    for (let ch = 0; ch < input.length; ch++) {
      const data = input[ch];
      for (let i = 0; i < n; i++) {
        const a = data[i] < 0 ? -data[i] : data[i];
        if (a > blockPeak) blockPeak = a;
      }
    }
    this.env = blockPeak > this.env ? blockPeak : this.env + (blockPeak - this.env) * 0.35;
    const envDb = 20 * Math.log10(Math.max(1e-7, this.env));

    if (this.open) {
      if (envDb < threshold - 2) {
        // Below threshold (with 2 dB hysteresis): run hold, then close.
        if (this.holdSamples > 0) this.holdSamples -= n;
        if (this.holdSamples <= 0) this.open = false;
      } else {
        this.holdSamples = holdSamples;
      }
    } else if (envDb > threshold) {
      this.open = true;
      this.holdSamples = holdSamples;
    }

    const target = this.open ? 1 : floorLin;
    for (let ch = 0; ch < output.length; ch++) {
      const src = input[Math.min(ch, input.length - 1)];
      const dst = output[ch];
      for (let i = 0; i < n; i++) {
        const step = target > this.gain ? attackStep : releaseStep;
        this.gain += Math.sign(target - this.gain) * Math.min(step, Math.abs(target - this.gain));
        dst[i] = src[i] * this.gain;
      }
    }
    return true;
  }
}

class FxSubOctaveProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.flip = 1;
    this.prevSample = 0;
  }

  process(_inputs, outputs, _parameters) {
    const input = _inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const n = input[0].length;
    for (let ch = 0; ch < output.length; ch++) {
      const src = input[Math.min(ch, input.length - 1)];
      const dst = output[ch];
      // Reset the shared flip state per channel pass? The divider state is
      // shared across channels on purpose (mono pitch tracking), so compute
      // only from channel 0 and apply the same square to all channels.
      let flip = this.flip;
      let prev = this.prevSample;
      if (ch === 0) {
        for (let i = 0; i < n; i++) {
          const x = src[i];
          if (prev <= 0 && x > 0) flip = -flip; // rising zero crossing → toggle
          dst[i] = x * flip;
          prev = x;
        }
        this.flip = flip;
        this.prevSample = prev;
      } else {
        for (let i = 0; i < n; i++) dst[i] = src[i] * flip;
      }
    }
    return true;
  }
}

registerProcessor('fx-gate-processor', FxGateProcessor);
registerProcessor('fx-sub-octave-processor', FxSubOctaveProcessor);
