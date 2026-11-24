import type { ChannelFxRackState, FxSlotId } from '../../types/audio.ts';
import { FX_CHAIN_ORDER, FX_EFFECTS } from './fxDefinition.ts';

/**
 * Real-world guitar pedal engines (Web Audio API).
 *
 * Every pedal is a slot shell:
 *
 *   input ─► bypassDry ─────────────────────────────► output   (footswitch OFF)
 *   input ─► [wet chain (own internal dry/mix)] ──► wetBus ─► output   (ON)
 *
 * Engaging crossfades bypassDry/wetBus over 15 ms (never disconnects
 * mid-audio); disengaging keeps the wet chain alive for a trails window so
 * delay and reverb repeats ring out naturally, then disposes the node graph —
 * an unengaged pedal costs ZERO audio-thread CPU.
 *
 * Real-world grounding: Tube-Screamer asymmetric tanh diode clip with 720 Hz
 * mid hump; POG-style octave voices (full-wave rectifier up, zero-crossing
 * divider down); CH-1 antiphase stereo chorus; dotted-eighth delay at
 * (60/bpm)·0.75; synthesized IR reverbs (room/hall/plate/spring).
 */

const RAMP_TAU = 0.02;

function ramp(param: AudioParam, value: number, time: number, tau = RAMP_TAU): void {
  param.setTargetAtTime(value, time, tau);
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

function mixGains(mix: number): [number, number] {
  const m = Math.min(1, Math.max(0, mix));
  return [Math.cos((m * Math.PI) / 2), Math.sin((m * Math.PI) / 2)];
}

// ---------------------------------------------------------------------------
// Shared worklet module loader (gate + sub-octave)
// ---------------------------------------------------------------------------

const workletModuleCache = new WeakMap<BaseAudioContext, Promise<void>>();
const readyContexts = new WeakSet<BaseAudioContext>();

export function ensureFxWorklets(ctx: BaseAudioContext): Promise<void> {
  let p = workletModuleCache.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule('/fx-worklets.js').then(() => {
      readyContexts.add(ctx);
    });
    workletModuleCache.set(ctx, p);
    p.catch(() => {
      // Allow a retry on the next attempt after a failed load.
      if (workletModuleCache.get(ctx) === p) workletModuleCache.delete(ctx);
    });
  }
  return p;
}

function areFxWorkletsReady(ctx: BaseAudioContext): boolean {
  return readyContexts.has(ctx);
}

// ---------------------------------------------------------------------------
// Slot engine base
// ---------------------------------------------------------------------------

abstract class FxSlotEngine {
  readonly slotId: FxSlotId;
  protected readonly ctx: BaseAudioContext;
  readonly input: GainNode;
  readonly output: GainNode;
  protected readonly wetBus: GainNode;
  protected readonly bypassDry: GainNode;
  protected wetNodes: AudioNode[] = [];
  protected wetHead: AudioNode | null = null;
  protected built = false;
  private engaged = false;
  private teardownTimer: number | null = null;
  /** Trails ring-out window (ms) before the wet graph is disposed. */
  protected readonly trailMs: number = 3800;

  constructor(ctx: BaseAudioContext, slotId: FxSlotId) {
    this.ctx = ctx;
    this.slotId = slotId;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wetBus = ctx.createGain();
    this.bypassDry = ctx.createGain();
    this.bypassDry.gain.value = 1;
    this.wetBus.gain.value = 0;
    this.input.connect(this.bypassDry);
    this.bypassDry.connect(this.output);
    this.wetBus.connect(this.output);
  }

  isEngaged(): boolean {
    return this.engaged;
  }

  setEngaged(on: boolean): void {
    if (this.teardownTimer !== null) {
      window.clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    if (on === this.engaged) {
      // Deferred build (e.g. worklet module finished loading after engage).
      if (on && !this.built && this.canBuild()) this.engageNow();
      return;
    }
    this.engaged = on;
    if (on) {
      if (!this.built) {
        if (!this.canBuild()) return; // stays in bypass until deps are ready
        this.buildNow();
      }
      this.crossfade(true);
    } else {
      this.crossfade(false);
      // Dispose the wet chain after the trails window (delay/reverb repeats).
      this.teardownTimer = window.setTimeout(() => {
        this.teardownTimer = null;
        this.disposeWet();
      }, this.trailMs);
    }
  }

  private engageNow(): void {
    this.buildNow();
    this.crossfade(true);
  }

  private crossfade(on: boolean): void {
    const t = this.ctx.currentTime;
    ramp(this.wetBus.gain, on ? 1 : 0, t, 0.015);
    ramp(this.bypassDry.gain, on ? 0 : 1, t, 0.015);
  }

  /** Worklet-dependent pedals override this. */
  protected canBuild(): boolean {
    return true;
  }

  private buildNow(): void {
    try {
      this.buildWet();
      this.built = true;
    } catch {
      // Node creation failure leaves the pedal in safe bypass.
      this.disposeWet();
    }
  }

  protected track(node: AudioNode): void {
    this.wetNodes.push(node);
  }

  protected trackOsc(osc: OscillatorNode): void {
    this.track(osc);
  }

  protected stopOscs(): void {
    for (const node of this.wetNodes) {
      if (node instanceof OscillatorNode) {
        try {
          node.stop();
        } catch {
          // already stopped
        }
      }
    }
  }

  /** Reads a knob with the real-world default as fallback. */
  protected p(params: Record<string, number>, id: string): number {
    const def = FX_EFFECTS[this.slotId].params.find((x) => x.id === id);
    const fallback = def ? def.default : 0;
    const raw = params?.[id];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  }

  protected disposeWet(): void {
    if (this.teardownTimer !== null) {
      window.clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    this.stopOscs();
    for (const node of this.wetNodes) {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.wetNodes = [];
    this.wetHead = null;
    this.built = false;
    this.engaged = false;
    // Drop every wet input tap (but keep the bypass path wired).
    try {
      this.input.disconnect();
      this.input.connect(this.bypassDry);
    } catch {
      // ignore
    }
    try {
      this.wetBus.gain.cancelScheduledValues(this.ctx.currentTime);
      this.wetBus.gain.value = 0;
      this.bypassDry.gain.cancelScheduledValues(this.ctx.currentTime);
      this.bypassDry.gain.value = 1;
    } catch {
      // ignore
    }
  }

  /** Rebuild the wet chain in-place (structural param changed). */
  protected rebuildWet(): void {
    if (!this.built) return;
    this.disposeWet();
    this.engageNow();
  }

  dispose(): void {
    this.disposeWet();
    try {
      this.input.disconnect();
      this.output.disconnect();
    } catch {
      // ignore
    }
  }

  applyParams(params: Record<string, number>): void {
    if (this.built) this.update(params);
  }

  protected abstract buildWet(): void;
  protected abstract update(params: Record<string, number>): void;
}

// ---------------------------------------------------------------------------
// 1. Noise Gate (worklet envelope-follower VCA, Boss NS-2 style)
// ---------------------------------------------------------------------------

class NoiseGateEngine extends FxSlotEngine {
  private node: AudioWorkletNode | null = null;

  protected canBuild(): boolean {
    return areFxWorkletsReady(this.ctx);
  }

  protected buildWet(): void {
    const worklet = new AudioWorkletNode(this.ctx, 'fx-gate-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.input.connect(worklet);
    worklet.connect(this.wetBus);
    this.wetHead = worklet;
    this.node = worklet;
    this.track(worklet);
  }

  protected update(params: Record<string, number>): void {
    if (!this.node) return;
    const t = this.ctx.currentTime;
    const set = (id: string, value: number) => {
      const ap = this.node?.parameters.get(id);
      if (ap) ap.setTargetAtTime(value, t, 0.05);
    };
    set('threshold', this.p(params, 'threshold'));
    set('floor', this.p(params, 'floor'));
    set('attack', this.p(params, 'attack'));
    set('release', this.p(params, 'release'));
  }
}

// ---------------------------------------------------------------------------
// 2. Wah (bandpass; manual / auto-LFO / envelope modes, Cry Baby style)
// ---------------------------------------------------------------------------

let cachedRectCurve: Float32Array<ArrayBuffer> | null = null;
function rectifierCurve(): Float32Array<ArrayBuffer> {
  if (cachedRectCurve) return cachedRectCurve;
  const n = 4096;
  const curve = new Float32Array(n) as Float32Array<ArrayBuffer>;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.abs(x);
  }
  cachedRectCurve = curve;
  return curve;
}

class WahEngine extends FxSlotEngine {
  private filter: BiquadFilterNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private envGain: GainNode | null = null;
  private dryMix: GainNode | null = null;
  private wetMix: GainNode | null = null;
  private mode = -1;

  protected buildWet(): void {
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 6;

    const dryMix = ctx.createGain();
    const wetMix = ctx.createGain();
    this.input.connect(dryMix);
    dryMix.connect(this.wetBus);
    this.input.connect(filter);
    filter.connect(wetMix);
    wetMix.connect(this.wetBus);

    this.filter = filter;
    this.dryMix = dryMix;
    this.wetMix = wetMix;
    this.lfo = null;
    this.lfoGain = null;
    this.envGain = null;
    this.wetHead = filter;
    this.mode = -1; // force mode wiring on first update
    this.track(filter);
    this.track(dryMix);
    this.track(wetMix);
  }

  protected update(params: Record<string, number>): void {
    if (!this.filter || !this.dryMix || !this.wetMix) return;
    const t = this.ctx.currentTime;
    const mode = Math.round(this.p(params, 'mode'));

    if (mode !== this.mode) {
      // Mode is structural: rebuild the wet graph (rare switch, clickless via
      // the engage crossfade).
      this.mode = mode;
      this.rebuildWet();
      if (!this.filter || !this.dryMix || !this.wetMix) return;

      if (mode === 1) {
        const lfo = this.ctx.createOscillator();
        lfo.type = 'sine';
        const lfoGain = this.ctx.createGain();
        lfo.connect(lfoGain);
        lfoGain.connect(this.filter.frequency);
        lfo.start();
        this.lfo = lfo;
        this.lfoGain = lfoGain;
        this.trackOsc(lfo);
        this.track(lfoGain);
      } else if (mode === 2) {
        // Envelope follower: |x| → 20 Hz LP → scaled gain → frequency.
        const rect = this.ctx.createWaveShaper();
        rect.curve = rectifierCurve();
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 20;
        const envGain = this.ctx.createGain();
        this.input.connect(rect);
        rect.connect(lp);
        lp.connect(envGain);
        envGain.connect(this.filter.frequency);
        this.envGain = envGain;
        this.track(rect);
        this.track(lp);
        this.track(envGain);
      }
    }

    const freqMin = this.p(params, 'freqMin');
    const freqMax = this.p(params, 'freqMax');
    const range = Math.max(0, freqMax - freqMin);
    ramp(this.filter.Q, this.p(params, 'q'), t, 0.05);

    const [dryG, wetG] = mixGains(this.p(params, 'mix'));
    ramp(this.dryMix.gain, dryG, t);
    ramp(this.wetMix.gain, wetG, t);

    if (mode === 0) {
      const position = this.p(params, 'position');
      ramp(this.filter.frequency, freqMin + position * range, t, 0.03);
    } else if (mode === 1 && this.lfo && this.lfoGain) {
      ramp(this.filter.frequency, freqMin + range / 2, t, 0.05);
      ramp(this.lfoGain.gain, range / 2, t, 0.05);
      ramp(this.lfo.frequency, this.p(params, 'rate'), t, 0.05);
    } else if (mode === 2) {
      ramp(this.filter.frequency, freqMin + range * 0.15, t, 0.05);
      if (this.envGain) {
        ramp(this.envGain.gain, this.p(params, 'sensitivity') * range * 0.8, t, 0.05);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Octaver (POG-style voices: rectified octave-up, worklet sub-octave)
// ---------------------------------------------------------------------------

class OctaverEngine extends FxSlotEngine {
  private dryV: GainNode | null = null;
  private upV: GainNode | null = null;
  private up2V: GainNode | null = null;
  private subV: GainNode | null = null;
  private lowpass: BiquadFilterNode | null = null;

  protected canBuild(): boolean {
    return areFxWorkletsReady(this.ctx);
  }

  protected buildWet(): void {
    const ctx = this.ctx;
    const sum = ctx.createGain();
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';

    // Dry voice.
    const dryV = ctx.createGain();
    this.input.connect(dryV);
    dryV.connect(sum);

    // Octave up: full-wave rectifier (2f harmonics) with DC stripped.
    const rect = ctx.createWaveShaper();
    rect.curve = rectifierCurve();
    const rectHp = ctx.createBiquadFilter();
    rectHp.type = 'highpass';
    rectHp.frequency.value = 60;
    const upV = ctx.createGain();
    this.input.connect(rect);
    rect.connect(rectHp);
    rectHp.connect(upV);
    upV.connect(sum);

    // Octave up ×2: bright shimmer layer of the rectified signal.
    const rectHp2 = ctx.createBiquadFilter();
    rectHp2.type = 'highpass';
    rectHp2.frequency.value = 900;
    const up2V = ctx.createGain();
    rectHp.connect(rectHp2);
    rectHp2.connect(up2V);
    up2V.connect(sum);

    // Octave down: monophonic zero-crossing divider worklet.
    const sub = new AudioWorkletNode(this.ctx, 'fx-sub-octave-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const subV = ctx.createGain();
    this.input.connect(sub);
    sub.connect(subV);
    subV.connect(sum);

    sum.connect(lowpass);
    lowpass.connect(this.wetBus);

    this.dryV = dryV;
    this.upV = upV;
    this.up2V = up2V;
    this.subV = subV;
    this.lowpass = lowpass;
    this.wetHead = sub;
    this.track(sum);
    this.track(dryV);
    this.track(rect);
    this.track(rectHp);
    this.track(upV);
    this.track(rectHp2);
    this.track(up2V);
    this.track(sub);
    this.track(subV);
    this.track(lowpass);
  }

  protected update(params: Record<string, number>): void {
    if (!this.dryV || !this.upV || !this.up2V || !this.subV || !this.lowpass) return;
    const t = this.ctx.currentTime;
    ramp(this.lowpass.frequency, this.p(params, 'lowpass'), t, 0.05);
    ramp(this.dryV.gain, this.p(params, 'dry'), t);
    ramp(this.upV.gain, this.p(params, 'octUp1') * 0.9, t);
    ramp(this.up2V.gain, this.p(params, 'octUp2') * 0.5, t);
    ramp(this.subV.gain, this.p(params, 'octDown1'), t);
  }
}

// ---------------------------------------------------------------------------
// 4. Compressor (DynamicsCompressor + makeup + parallel blend)
// ---------------------------------------------------------------------------

class CompressorEngine extends FxSlotEngine {
  private comp: DynamicsCompressorNode | null = null;
  private makeup: GainNode | null = null;
  private wetBlend: GainNode | null = null;
  private dryBlend: GainNode | null = null;

  protected buildWet(): void {
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const wetBlend = ctx.createGain();
    const dryBlend = ctx.createGain();
    this.input.connect(comp);
    comp.connect(makeup);
    makeup.connect(wetBlend);
    wetBlend.connect(this.wetBus);
    this.input.connect(dryBlend);
    dryBlend.connect(this.wetBus);
    this.wetHead = comp;
    this.comp = comp;
    this.makeup = makeup;
    this.wetBlend = wetBlend;
    this.dryBlend = dryBlend;
    this.track(comp);
    this.track(makeup);
    this.track(wetBlend);
    this.track(dryBlend);
  }

  protected update(params: Record<string, number>): void {
    if (!this.comp || !this.makeup || !this.wetBlend || !this.dryBlend) return;
    const t = this.ctx.currentTime;
    const blend = this.p(params, 'blend');
    ramp(this.comp.threshold, this.p(params, 'threshold'), t);
    ramp(this.comp.ratio, this.p(params, 'ratio'), t);
    ramp(this.comp.attack, this.p(params, 'attack') / 1000, t);
    ramp(this.comp.release, this.p(params, 'release') / 1000, t);
    ramp(this.comp.knee, 12, t);
    ramp(this.makeup.gain, dbToLin(this.p(params, 'makeup')), t);
    ramp(this.wetBlend.gain, blend, t);
    ramp(this.dryBlend.gain, 1 - blend, t);
  }
}

// ---------------------------------------------------------------------------
// 5/6. Overdrive (TS/Klon asymmetric tanh) & Distortion (hard symmetric)
// ---------------------------------------------------------------------------

function softClipCurve(k: number, bias: number, n = 8192): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n) as Float32Array<ArrayBuffer>;
  const denom = 1 - Math.tanh(k * bias);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = (Math.tanh(k * (x + bias)) - Math.tanh(k * bias)) / Math.max(1e-6, denom);
  }
  return curve;
}

function hardClipCurve(k: number, n = 8192): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n) as Float32Array<ArrayBuffer>;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

abstract class DriveEngine extends FxSlotEngine {
  protected preGain: GainNode | null = null;
  protected shaper: WaveShaperNode | null = null;
  protected toneLp: BiquadFilterNode | null = null;
  protected levelGain: GainNode | null = null;
  protected lowCutHp: BiquadFilterNode | null = null;

  protected buildDrive(mid: BiquadFilterNode | null): void {
    const ctx = this.ctx;
    const preGain = ctx.createGain();
    const lowCutHp = ctx.createBiquadFilter();
    lowCutHp.type = 'highpass';
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '4x';
    const toneLp = ctx.createBiquadFilter();
    toneLp.type = 'lowpass';
    const levelGain = ctx.createGain();

    this.input.connect(preGain);
    let node: AudioNode = preGain;
    node.connect(lowCutHp);
    node = lowCutHp;
    if (mid) {
      node.connect(mid);
      node = mid;
    }
    node.connect(shaper);
    node = shaper;
    node.connect(toneLp);
    node = toneLp;
    node.connect(levelGain);
    levelGain.connect(this.wetBus);

    this.preGain = preGain;
    this.lowCutHp = lowCutHp;
    this.shaper = shaper;
    this.toneLp = toneLp;
    this.levelGain = levelGain;
    this.wetHead = preGain;
    this.track(preGain);
    this.track(lowCutHp);
    if (mid) this.track(mid);
    this.track(shaper);
    this.track(toneLp);
    this.track(levelGain);
  }
}

class OverdriveEngine extends DriveEngine {
  private mid: BiquadFilterNode | null = null;

  protected buildWet(): void {
    const mid = this.ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 720;
    mid.Q.value = 1.1;
    this.mid = mid;
    this.buildDrive(mid);
  }

  protected update(params: Record<string, number>): void {
    if (!this.preGain || !this.shaper || !this.toneLp || !this.levelGain || !this.lowCutHp || !this.mid) {
      return;
    }
    const t = this.ctx.currentTime;
    const drive = this.p(params, 'drive');
    const character = Math.round(this.p(params, 'character'));
    const tone = this.p(params, 'tone');

    ramp(this.preGain.gain, dbToLin(drive * 24), t);
    ramp(this.lowCutHp.frequency, this.p(params, 'lowCut'), t, 0.05);
    ramp(this.mid.gain, character === 1 ? 1 : this.p(params, 'midHump'), t);
    // TS tone stack: 800 Hz .. 10 kHz exponential map.
    const toneHz = 800 * Math.pow(10000 / 800, tone);
    ramp(this.toneLp.frequency, toneHz, t, 0.05);
    ramp(this.levelGain.gain, dbToLin(this.p(params, 'level')), t);

    const k = character === 1 ? 0.6 + drive * 4 : 1 + drive * 7;
    const bias = character === 1 ? 0.01 : 0.04;
    this.shaper.curve = softClipCurve(k, bias);
  }
}

class DistortionEngine extends DriveEngine {
  protected buildWet(): void {
    this.buildDrive(null);
  }

  protected update(params: Record<string, number>): void {
    if (!this.preGain || !this.shaper || !this.toneLp || !this.levelGain || !this.lowCutHp) {
      return;
    }
    const t = this.ctx.currentTime;
    const drive = this.p(params, 'drive');
    ramp(this.preGain.gain, dbToLin(drive * 40), t);
    ramp(this.lowCutHp.frequency, this.p(params, 'lowCut'), t, 0.05);
    ramp(this.toneLp.frequency, this.p(params, 'tone'), t, 0.05);
    ramp(this.levelGain.gain, dbToLin(this.p(params, 'level')), t);
    this.shaper.curve = hardClipCurve(2 + drive * 13);
  }
}

// ---------------------------------------------------------------------------
// 7. Phaser (cascaded allpass notches, LFO, feedback — Phase 90 / PH-3)
// ---------------------------------------------------------------------------

class PhaserEngine extends FxSlotEngine {
  private allpass: BiquadFilterNode[] = [];
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private fbDelay: DelayNode | null = null;
  private fbGain: GainNode | null = null;
  private dryMix: GainNode | null = null;
  private wetMix: GainNode | null = null;
  private stages = -1;

  protected buildWet(): void {
    const ctx = this.ctx;
    const sum = ctx.createGain();
    const fbDelay = ctx.createDelay(0.005);
    fbDelay.delayTime.value = 0.002;
    const fbGain = ctx.createGain();
    fbGain.connect(sum);
    sum.connect(fbDelay);
    fbDelay.connect(fbGain);

    const allpass: BiquadFilterNode[] = [];
    let node: AudioNode = sum;
    for (let i = 0; i < 8; i++) {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = 700 * Math.pow(1.7, i);
      node.connect(ap);
      node = ap;
      allpass.push(ap);
      this.track(ap);
    }

    const dryMix = ctx.createGain();
    const wetMix = ctx.createGain();
    this.input.connect(dryMix);
    dryMix.connect(this.wetBus);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const lfoGain = ctx.createGain();
    lfo.connect(lfoGain);
    lfo.start();
    for (const ap of allpass) lfoGain.connect(ap.frequency);

    this.allpass = allpass;
    this.dryMix = dryMix;
    this.wetMix = wetMix;
    this.lfo = lfo;
    this.lfoGain = lfoGain;
    this.fbDelay = fbDelay;
    this.fbGain = fbGain;
    this.wetHead = sum;
    this.track(sum);
    this.track(fbDelay);
    this.track(fbGain);
    this.track(dryMix);
    this.track(wetMix);
    this.trackOsc(lfo);
    this.track(lfoGain);
    this.stages = -1;
  }

  private rewireStageCount(stages: number): void {
    if (!this.wetMix || !this.fbDelay) return;
    const tap = this.allpass[stages - 1];
    if (!tap) return;
    for (let i = 0; i < this.allpass.length; i++) {
      try {
        this.allpass[i].disconnect();
      } catch {
        // ignore
      }
      if (i < this.allpass.length - 1) {
        try {
          this.allpass[i].connect(this.allpass[i + 1]);
        } catch {
          // ignore
        }
      }
    }
    try {
      tap.connect(this.wetMix);
      tap.connect(this.fbDelay);
    } catch {
      // ignore
    }
  }

  protected update(params: Record<string, number>): void {
    if (!this.dryMix || !this.wetMix || !this.lfo || !this.lfoGain || !this.fbGain || this.allpass.length === 0) {
      return;
    }
    const t = this.ctx.currentTime;
    const stages = Math.round(this.p(params, 'stages')) === 1 ? 8 : 4;
    if (stages !== this.stages) {
      this.stages = stages;
      this.rewireStageCount(stages);
    }

    const [dryG, wetG] = mixGains(this.p(params, 'mix'));
    ramp(this.dryMix.gain, dryG, t);
    ramp(this.wetMix.gain, wetG, t);
    ramp(this.lfoGain.gain, this.p(params, 'depth') * 700 * 0.4, t, 0.05);
    ramp(this.lfo.frequency, this.p(params, 'rate'), t, 0.05);
    ramp(this.fbGain.gain, this.p(params, 'feedback') * 0.7, t, 0.05);
  }
}

// ---------------------------------------------------------------------------
// 8. Chorus (CH-1 antiphase stereo modulated delays)
// ---------------------------------------------------------------------------

class ChorusEngine extends FxSlotEngine {
  private delayL: DelayNode | null = null;
  private delayR: DelayNode | null = null;
  private lfo: OscillatorNode | null = null;
  private posGain: GainNode | null = null;
  private toneLp: BiquadFilterNode | null = null;
  private dryMix: GainNode | null = null;
  private wetMix: GainNode | null = null;

  protected buildWet(): void {
    const ctx = this.ctx;
    const splitter = ctx.createChannelSplitter(2);
    const delayL = ctx.createDelay(0.1);
    const delayR = ctx.createDelay(0.1);
    const merger = ctx.createChannelMerger(2);
    const toneLp = ctx.createBiquadFilter();
    toneLp.type = 'lowpass';
    const dryMix = ctx.createGain();
    const wetMix = ctx.createGain();

    this.input.connect(splitter);
    splitter.connect(delayL, 0);
    splitter.connect(delayR, 1);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    merger.connect(toneLp);
    toneLp.connect(wetMix);
    wetMix.connect(this.wetBus);
    this.input.connect(dryMix);
    dryMix.connect(this.wetBus);

    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    const posGain = ctx.createGain();
    const negGain = ctx.createGain();
    negGain.gain.value = -1;
    lfo.connect(posGain);
    lfo.connect(negGain);
    posGain.connect(delayL.delayTime);
    negGain.connect(delayR.delayTime);
    lfo.start();

    this.delayL = delayL;
    this.delayR = delayR;
    this.lfo = lfo;
    this.posGain = posGain;
    this.toneLp = toneLp;
    this.dryMix = dryMix;
    this.wetMix = wetMix;
    this.wetHead = splitter;
    this.track(splitter);
    this.track(delayL);
    this.track(delayR);
    this.track(merger);
    this.track(toneLp);
    this.track(dryMix);
    this.track(wetMix);
    this.trackOsc(lfo);
    this.track(posGain);
    this.track(negGain);
  }

  protected update(params: Record<string, number>): void {
    if (!this.delayL || !this.delayR || !this.lfo || !this.posGain || !this.toneLp || !this.dryMix || !this.wetMix) {
      return;
    }
    const t = this.ctx.currentTime;
    const base = this.p(params, 'delayMs') / 1000;
    ramp(this.delayL.delayTime, base, t, 0.05);
    ramp(this.delayR.delayTime, base, t, 0.05);
    ramp(this.lfo.frequency, this.p(params, 'rate'), t, 0.05);
    // Depth in seconds (delayTime is a-rate; LFO gain must be scaled to s).
    ramp(this.posGain.gain, this.p(params, 'depth') * 0.004, t, 0.05);
    ramp(this.toneLp.frequency, this.p(params, 'tone'), t, 0.05);
    const [dryG, wetG] = mixGains(this.p(params, 'mix'));
    ramp(this.dryMix.gain, dryG, t);
    ramp(this.wetMix.gain, wetG, t);
  }
}

// ---------------------------------------------------------------------------
// 9. Flanger (short modulated delay + feedback)
// ---------------------------------------------------------------------------

class FlangerEngine extends FxSlotEngine {
  private delay: DelayNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private fbGain: GainNode | null = null;
  private dryMix: GainNode | null = null;
  private wetMix: GainNode | null = null;

  protected buildWet(): void {
    const ctx = this.ctx;
    const sum = ctx.createGain();
    const delay = ctx.createDelay(0.05);
    const fbGain = ctx.createGain();
    const dryMix = ctx.createGain();
    const wetMix = ctx.createGain();

    this.input.connect(sum);
    this.input.connect(dryMix);
    dryMix.connect(this.wetBus);
    sum.connect(delay);
    delay.connect(wetMix);
    wetMix.connect(this.wetBus);
    delay.connect(fbGain);
    fbGain.connect(sum);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const lfoGain = ctx.createGain();
    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();

    this.delay = delay;
    this.lfo = lfo;
    this.lfoGain = lfoGain;
    this.fbGain = fbGain;
    this.dryMix = dryMix;
    this.wetMix = wetMix;
    this.wetHead = sum;
    this.track(sum);
    this.track(delay);
    this.track(fbGain);
    this.track(dryMix);
    this.track(wetMix);
    this.trackOsc(lfo);
    this.track(lfoGain);
  }

  protected update(params: Record<string, number>): void {
    if (!this.delay || !this.lfo || !this.lfoGain || !this.fbGain || !this.dryMix || !this.wetMix) {
      return;
    }
    const t = this.ctx.currentTime;
    ramp(this.delay.delayTime, 0.003, t, 0.05);
    ramp(this.lfo.frequency, this.p(params, 'rate'), t, 0.05);
    ramp(this.lfoGain.gain, this.p(params, 'depth') * 0.005, t, 0.05);
    ramp(this.fbGain.gain, this.p(params, 'feedback'), t, 0.05);
    const [dryG, wetG] = mixGains(this.p(params, 'mix'));
    ramp(this.dryMix.gain, dryG, t);
    ramp(this.wetMix.gain, wetG, t);
  }
}

// ---------------------------------------------------------------------------
// 10. Tremolo (LFO VCA, Boss TR-2 wave shapes)
// ---------------------------------------------------------------------------

class TremoloEngine extends FxSlotEngine {
  private vca: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;

  protected buildWet(): void {
    const ctx = this.ctx;
    const vca = ctx.createGain();
    this.input.connect(vca);
    vca.connect(this.wetBus);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const lfoGain = ctx.createGain();
    lfo.connect(lfoGain);
    lfoGain.connect(vca.gain);
    lfo.start();

    this.vca = vca;
    this.lfo = lfo;
    this.lfoGain = lfoGain;
    this.wetHead = vca;
    this.track(vca);
    this.trackOsc(lfo);
    this.track(lfoGain);
  }

  protected update(params: Record<string, number>): void {
    if (!this.vca || !this.lfo || !this.lfoGain) return;
    const t = this.ctx.currentTime;
    const depth = this.p(params, 'depth');
    const wave = Math.round(this.p(params, 'waveform'));
    const type: OscillatorType = wave === 1 ? 'triangle' : wave === 2 ? 'square' : 'sine';
    if (this.lfo.type !== type) this.lfo.type = type;
    ramp(this.lfo.frequency, this.p(params, 'rate'), t, 0.05);
    ramp(this.lfoGain.gain, depth / 2, t, 0.05);
    ramp(this.vca.gain, 1 - depth / 2, t, 0.05);
  }
}

// ---------------------------------------------------------------------------
// 11. Delay (dotted-eighth worship echo; digital/analog/tape)
// ---------------------------------------------------------------------------

const SUBDIVISION_FACTORS = [1, 0.5, 0.75, 2];

class DelayEngine extends FxSlotEngine {
  private delay: DelayNode | null = null;
  private toneLp: BiquadFilterNode | null = null;
  private fbGain: GainNode | null = null;
  private dryMix: GainNode | null = null;
  private wetMix: GainNode | null = null;
  private wobbleLfo: OscillatorNode | null = null;
  private wobbleGain: GainNode | null = null;
  protected readonly trailMs = 6000; // let long feedback tails ring out

  protected buildWet(): void {
    const ctx = this.ctx;
    const sum = ctx.createGain();
    const delay = ctx.createDelay(2.5);
    const toneLp = ctx.createBiquadFilter();
    toneLp.type = 'lowpass';
    const fbGain = ctx.createGain();
    const dryMix = ctx.createGain();
    const wetMix = ctx.createGain();

    this.input.connect(sum);
    this.input.connect(dryMix);
    dryMix.connect(this.wetBus);
    sum.connect(delay);
    delay.connect(toneLp);
    toneLp.connect(wetMix);
    wetMix.connect(this.wetBus);
    toneLp.connect(fbGain);
    fbGain.connect(sum);

    this.delay = delay;
    this.toneLp = toneLp;
    this.fbGain = fbGain;
    this.dryMix = dryMix;
    this.wetMix = wetMix;
    this.wetHead = sum;
    this.track(sum);
    this.track(delay);
    this.track(toneLp);
    this.track(fbGain);
    this.track(dryMix);
    this.track(wetMix);
  }

  private syncWobble(mode: number): void {
    const wantWobble = mode !== 0; // analog + tape
    if (wantWobble && !this.wobbleLfo && this.delay) {
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = mode === 1 ? 0.5 : 0.3;
      const g = this.ctx.createGain();
      g.gain.value = mode === 1 ? 0.0003 : 0.001;
      lfo.connect(g);
      g.connect(this.delay.delayTime);
      lfo.start();
      this.wobbleLfo = lfo;
      this.wobbleGain = g;
      this.trackOsc(lfo);
      this.track(g);
    } else if (!wantWobble && this.wobbleLfo) {
      try {
        this.wobbleLfo.stop();
        this.wobbleLfo.disconnect();
        if (this.wobbleGain) this.wobbleGain.disconnect();
      } catch {
        // ignore
      }
      this.wetNodes = this.wetNodes.filter((n) => n !== this.wobbleLfo && n !== this.wobbleGain);
      this.wobbleLfo = null;
      this.wobbleGain = null;
    }
  }

  protected update(params: Record<string, number>): void {
    if (!this.delay || !this.toneLp || !this.fbGain || !this.dryMix || !this.wetMix) return;
    const t = this.ctx.currentTime;
    const bpm = this.p(params, 'bpm');
    const subdiv = Math.round(this.p(params, 'subdivision'));
    const factor = SUBDIVISION_FACTORS[Math.min(3, Math.max(0, subdiv))];
    const timeSec = Math.min(2.4, (60 / Math.max(40, bpm)) * factor);
    ramp(this.delay.delayTime, timeSec, t, 0.05);

    const mode = Math.round(this.p(params, 'mode'));
    this.syncWobble(mode);

    ramp(this.toneLp.frequency, this.p(params, 'tone'), t, 0.05);
    const [dryG, wetG] = mixGains(this.p(params, 'mix'));
    ramp(this.dryMix.gain, dryG, t);
    ramp(this.wetMix.gain, wetG, t);
    ramp(this.fbGain.gain, this.p(params, 'feedback'), t, 0.05);
  }
}

// ---------------------------------------------------------------------------
// 12. Reverb (ConvolverNode with synthesized IRs — RV-6/BigSky styles)
// ---------------------------------------------------------------------------

const irCache = new Map<string, AudioBuffer>();

function reverbIR(ctx: BaseAudioContext, type: number, decaySec: number): AudioBuffer {
  const key = `${type}:${decaySec.toFixed(1)}:${ctx.sampleRate}`;
  const cached = irCache.get(key);
  if (cached) return cached;

  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.round(decaySec * sr));
  const buffer = ctx.createBuffer(2, len, sr);
  const exponent = type === 0 ? 2.2 : type === 1 ? 2.8 : type === 2 ? 1.3 : 3.2;

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, exponent);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    if (type === 2) {
      // Plate: denser early build-up.
      const early = Math.min(len, Math.round(sr * 0.08));
      for (let i = 0; i < early; i++) {
        data[i] *= 1 + 2 * (1 - i / early);
      }
    }
    if (type === 3) {
      // Spring: a couple of discrete "boing" reflections.
      const addPulse = (atSec: number, amp: number) => {
        const start = Math.round(atSec * sr);
        const pulseLen = Math.round(sr * 0.05);
        for (let i = 0; i + start < len && i < pulseLen; i++) {
          data[start + i] +=
            amp * Math.sin((i / pulseLen) * Math.PI * 6) * (1 - i / pulseLen);
        }
      };
      if (ch === 0) {
        addPulse(0.012, 0.5);
        addPulse(0.045, 0.25);
      } else {
        addPulse(0.018, 0.5);
        addPulse(0.052, 0.25);
      }
    }
  }

  irCache.set(key, buffer);
  // Keep the cache bounded (type × decay variants are few, but be safe).
  if (irCache.size > 24) {
    const first = irCache.keys().next().value;
    if (first !== undefined) irCache.delete(first);
  }
  return buffer;
}

class ReverbEngine extends FxSlotEngine {
  private convolver: ConvolverNode | null = null;
  private preDelay: DelayNode | null = null;
  private lowCutHp: BiquadFilterNode | null = null;
  private highCutLp: BiquadFilterNode | null = null;
  private dryMix: GainNode | null = null;
  private wetMix: GainNode | null = null;
  private irKey = '';
  protected readonly trailMs = 9000; // long cathedral tails

  protected buildWet(): void {
    const ctx = this.ctx;
    const preDelay = ctx.createDelay(0.2);
    const lowCutHp = ctx.createBiquadFilter();
    lowCutHp.type = 'highpass';
    const convolver = ctx.createConvolver();
    const highCutLp = ctx.createBiquadFilter();
    highCutLp.type = 'lowpass';
    const dryMix = ctx.createGain();
    const wetMix = ctx.createGain();

    this.input.connect(preDelay);
    preDelay.connect(lowCutHp);
    lowCutHp.connect(convolver);
    convolver.connect(highCutLp);
    highCutLp.connect(wetMix);
    wetMix.connect(this.wetBus);
    this.input.connect(dryMix);
    dryMix.connect(this.wetBus);

    this.convolver = convolver;
    this.preDelay = preDelay;
    this.lowCutHp = lowCutHp;
    this.highCutLp = highCutLp;
    this.dryMix = dryMix;
    this.wetMix = wetMix;
    this.wetHead = preDelay;
    this.track(preDelay);
    this.track(lowCutHp);
    this.track(convolver);
    this.track(highCutLp);
    this.track(dryMix);
    this.track(wetMix);
  }

  protected update(params: Record<string, number>): void {
    if (!this.convolver || !this.preDelay || !this.lowCutHp || !this.highCutLp || !this.dryMix || !this.wetMix) {
      return;
    }
    const t = this.ctx.currentTime;
    const type = Math.round(this.p(params, 'type'));
    const decay = this.p(params, 'decay');
    const irKey = `${type}:${decay.toFixed(1)}`;
    if (irKey !== this.irKey) {
      this.irKey = irKey;
      this.convolver.buffer = reverbIR(this.ctx, type, decay);
    }
    ramp(this.preDelay.delayTime, this.p(params, 'predelay') / 1000, t, 0.05);
    ramp(this.lowCutHp.frequency, this.p(params, 'lowCut'), t, 0.05);
    ramp(this.highCutLp.frequency, this.p(params, 'highCut'), t, 0.05);
    const [dryG, wetG] = mixGains(this.p(params, 'mix'));
    ramp(this.dryMix.gain, dryG, t);
    ramp(this.wetMix.gain, wetG, t);
  }
}

// ---------------------------------------------------------------------------
// Rack assembly
// ---------------------------------------------------------------------------

const WORKLET_SLOTS: ReadonlySet<FxSlotId> = new Set(['noiseGate', 'octaver']);

function createEngine(ctx: BaseAudioContext, slotId: FxSlotId): FxSlotEngine {
  switch (slotId) {
    case 'noiseGate':
      return new NoiseGateEngine(ctx, slotId);
    case 'wah':
      return new WahEngine(ctx, slotId);
    case 'octaver':
      return new OctaverEngine(ctx, slotId);
    case 'compressor':
      return new CompressorEngine(ctx, slotId);
    case 'overdrive':
      return new OverdriveEngine(ctx, slotId);
    case 'distortion':
      return new DistortionEngine(ctx, slotId);
    case 'phaser':
      return new PhaserEngine(ctx, slotId);
    case 'chorus':
      return new ChorusEngine(ctx, slotId);
    case 'flanger':
      return new FlangerEngine(ctx, slotId);
    case 'tremolo':
      return new TremoloEngine(ctx, slotId);
    case 'delay':
      return new DelayEngine(ctx, slotId);
    case 'reverb':
      return new ReverbEngine(ctx, slotId);
  }
}

/**
 * Per-channel FX rack inserted between the channel EQ and the strip
 * compressor. Slot engines are wired in canonical pedal order; each is a
 * clickless unity passthrough until its pedal is engaged, and the whole wet
 * graph is disposed when the rack is off — zero idle audio-thread cost.
 */
export class ChannelFxRack {
  private ctx: BaseAudioContext | null = null;
  private input: GainNode | null = null;
  private output: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private engines = new Map<FxSlotId, FxSlotEngine>();
  private lastSig: string | null = null;
  private rackTeardownTimer: number | null = null;
  private workletState: 'unloaded' | 'loading' | 'ready' | 'failed' = 'unloaded';
  private lastState: ChannelFxRackState | null = null;

  attach(ctx: BaseAudioContext, upstream: AudioNode, downstream: AudioNode): void {
    if (this.ctx === ctx && this.input) return;
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.dryGain.gain.value = 1;
    this.wetGain.gain.value = 0;
    upstream.connect(this.input);
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);
    this.output.connect(downstream);
    this.lastSig = null;
    // Re-apply the last known state after a context rebuild.
    if (this.lastState) {
      const st = this.lastState;
      this.lastState = null;
      this.applyState(st);
    }
  }

  private ensureWorklets(): void {
    if (this.workletState !== 'unloaded' || !this.ctx) return;
    this.workletState = 'loading';
    const ctx = this.ctx;
    ensureFxWorklets(ctx)
      .then(() => {
        this.workletState = 'ready';
        // Re-apply so gate/octaver pedals build now.
        this.lastSig = null;
        if (this.lastState) this.applyState(this.lastState);
      })
      .catch(() => {
        this.workletState = 'failed';
      });
  }

  private insertEngine(engine: FxSlotEngine): void {
    if (!this.input || !this.wetGain) return;
    const slotId = engine.slotId;
    const builtOrder = FX_CHAIN_ORDER.filter((id) => this.engines.has(id));
    const prevIds = builtOrder.filter((id) => FX_CHAIN_ORDER.indexOf(id) < FX_CHAIN_ORDER.indexOf(slotId));
    const nextIds = builtOrder.filter((id) => FX_CHAIN_ORDER.indexOf(id) > FX_CHAIN_ORDER.indexOf(slotId));

    const prev = prevIds.length > 0 ? this.engines.get(prevIds[prevIds.length - 1]) : null;
    const next = nextIds.length > 0 ? this.engines.get(nextIds[0]) : null;
    const from = prev ? prev.output : this.input;
    const to = next ? next.input : this.wetGain;

    // Splice the new (still bypassed, unity passthrough) engine into the chain.
    try {
      from.disconnect(to);
    } catch {
      // No pre-existing link on first insertion.
    }
    try {
      from.connect(engine.input);
      engine.output.connect(to);
    } catch {
      // ignore
    }
    this.engines.set(slotId, engine);
  }

  applyState(raw: ChannelFxRackState | undefined): void {
    if (!this.ctx || !this.input || !this.output || !this.dryGain || !this.wetGain) return;
    this.lastState = raw ?? null;
    const sig = raw ? `${raw.enabled ? 1 : 0}|${JSON.stringify(raw.slots)}` : 'off';
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const t = this.ctx.currentTime;

    if (!raw || !raw.enabled) {
      // Rack bypass: crossfade to dry, hard-tear the wet chain after trails.
      ramp(this.dryGain.gain, 1, t, 0.015);
      ramp(this.wetGain.gain, 0, t, 0.015);
      if (this.rackTeardownTimer === null) {
        this.rackTeardownTimer = window.setTimeout(() => {
          this.rackTeardownTimer = null;
          this.teardownEngines();
        }, 9500);
      }
      return;
    }

    if (this.rackTeardownTimer !== null) {
      window.clearTimeout(this.rackTeardownTimer);
      this.rackTeardownTimer = null;
    }
    ramp(this.dryGain.gain, 0, t, 0.015);
    ramp(this.wetGain.gain, 1, t, 0.015);

    // Kick worklet module loading early when a worklet pedal wants to engage.
    const needsWorklets = FX_CHAIN_ORDER.some(
      (id) => WORKLET_SLOTS.has(id) && raw.slots?.[id]?.engaged
    );
    if (needsWorklets && this.workletState === 'unloaded') this.ensureWorklets();

    for (const slotId of FX_CHAIN_ORDER) {
      const slotState = raw.slots?.[slotId];
      const engaged = slotState?.engaged === true;

      // Worklet pedals that have never been built wait for the module.
      const workletBlocked = WORKLET_SLOTS.has(slotId) && this.workletState !== 'ready';
      if (workletBlocked && !this.engines.has(slotId)) continue;

      if (engaged && !this.engines.has(slotId)) {
        this.insertEngine(createEngine(this.ctx, slotId));
      }

      const engine = this.engines.get(slotId);
      if (engine) {
        engine.setEngaged(engaged);
        if (engaged && slotState?.params) engine.applyParams(slotState.params);
      }
    }
  }

  private teardownEngines(): void {
    for (const engine of this.engines.values()) {
      engine.dispose();
    }
    this.engines.clear();
  }

  dispose(): void {
    if (this.rackTeardownTimer !== null) {
      window.clearTimeout(this.rackTeardownTimer);
      this.rackTeardownTimer = null;
    }
    this.teardownEngines();
    try {
      this.input?.disconnect();
      this.output?.disconnect();
      this.dryGain?.disconnect();
      this.wetGain?.disconnect();
    } catch {
      // ignore
    }
    this.input = null;
    this.output = null;
    this.dryGain = null;
    this.wetGain = null;
    this.ctx = null;
    this.lastSig = null;
    this.lastState = null;
  }
}
