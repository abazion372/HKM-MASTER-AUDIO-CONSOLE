import type { ChannelFxRackState, FxSlotId, FxSlotState } from '../../types/audio.ts';

/**
 * Real-world guitar pedal canon for the HKM channel FX rack.
 *
 * Chain order + parameter ranges are grounded in the classic stompbox
 * signal-flow (JHS pedal-order guide) and the modern worship-guitar rig
 * (tuner → compressor → Tube-Screamer-style overdrive → dotted-eighth
 * delay → hall reverb), plus the worship ambient "swells" presets
 * (800 ms / 62 % feedback delay, 140 Hz low-cut / 8 kHz high-cut reverb).
 */

export interface FxParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  unit?: string;
  /** When set, the numeric value is an index into these option labels. */
  options?: string[];
}

export interface FxEffectDef {
  id: FxSlotId;
  name: string;
  short: string;
  archetype: string;
  description: string;
  /** Accent color classes for the engaged LED + chip (slate/teal palette). */
  accent: 'slate' | 'amber' | 'violet' | 'emerald' | 'cyan' | 'rose';
  params: FxParamDef[];
}

export const FX_CHAIN_ORDER: FxSlotId[] = [
  'noiseGate',
  'wah',
  'octaver',
  'compressor',
  'overdrive',
  'distortion',
  'phaser',
  'chorus',
  'flanger',
  'tremolo',
  'delay',
  'reverb',
];

export const FX_EFFECTS: Record<FxSlotId, FxEffectDef> = {
  noiseGate: {
    id: 'noiseGate',
    name: 'Noise Gate',
    short: 'GATE',
    archetype: 'Boss NS-2 style',
    description:
      'Silences hum and hiss between phrases so quiet prayer moments stay quiet.',
    accent: 'slate',
    params: [
      { id: 'threshold', label: 'Threshold', min: -90, max: -10, default: -55, step: 1, unit: 'dB' },
      { id: 'floor', label: 'Floor', min: -80, max: 0, default: -40, step: 1, unit: 'dB' },
      { id: 'attack', label: 'Attack', min: 1, max: 20, default: 2, step: 1, unit: 'ms' },
      { id: 'release', label: 'Release', min: 20, max: 500, default: 120, step: 10, unit: 'ms' },
    ],
  },
  wah: {
    id: 'wah',
    name: 'Wah Filter',
    short: 'WAH',
    archetype: 'Cry Baby / auto-wah',
    description:
      'The classic "talking" pedal — a sweeping vowel-like filter for gentle accents or full funk.',
    accent: 'amber',
    params: [
      { id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, options: ['Manual', 'Auto LFO', 'Envelope'] },
      { id: 'position', label: 'Position', min: 0, max: 1, default: 0.5, step: 0.01 },
      { id: 'freqMin', label: 'Sweep Min', min: 200, max: 600, default: 300, step: 10, unit: 'Hz' },
      { id: 'freqMax', label: 'Sweep Max', min: 1200, max: 2500, default: 1600, step: 50, unit: 'Hz' },
      { id: 'q', label: 'Q', min: 1, max: 12, default: 6, step: 0.5 },
      { id: 'rate', label: 'LFO Rate', min: 0.1, max: 8, default: 1.5, step: 0.1, unit: 'Hz' },
      { id: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, default: 0.6, step: 0.05 },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, step: 0.05 },
    ],
  },
  octaver: {
    id: 'octaver',
    name: 'Octaver',
    short: 'OCT',
    archetype: 'EHX POG-style',
    description:
      'Adds octaves above and below the instrument — instant ambient-pad and organ textures behind the band.',
    accent: 'violet',
    params: [
      { id: 'octUp1', label: 'Oct Up', min: 0, max: 1, default: 0.35, step: 0.05 },
      { id: 'octUp2', label: 'Oct Up ×2', min: 0, max: 1, default: 0, step: 0.05 },
      { id: 'octDown1', label: 'Oct Down', min: 0, max: 1, default: 0.25, step: 0.05 },
      { id: 'dry', label: 'Dry', min: 0, max: 1, default: 0.8, step: 0.05 },
      { id: 'lowpass', label: 'Lowpass', min: 200, max: 8000, default: 8000, step: 100, unit: 'Hz' },
    ],
  },
  compressor: {
    id: 'compressor',
    name: 'Compressor',
    short: 'COMP',
    archetype: 'MXR Dyna Comp / CS-3',
    description:
      'Smooths out strums and evens volume so every chord sits nicely in the mix; adds sustain.',
    accent: 'cyan',
    params: [
      { id: 'threshold', label: 'Threshold', min: -60, max: 0, default: -25, step: 1, unit: 'dB' },
      { id: 'ratio', label: 'Ratio', min: 1, max: 20, default: 4, step: 0.5, unit: ':1' },
      { id: 'attack', label: 'Attack', min: 1, max: 100, default: 10, step: 1, unit: 'ms' },
      { id: 'release', label: 'Release', min: 30, max: 1000, default: 250, step: 10, unit: 'ms' },
      { id: 'makeup', label: 'Makeup', min: 0, max: 24, default: 6, step: 0.5, unit: 'dB' },
      { id: 'blend', label: 'Blend', min: 0, max: 1, default: 1, step: 0.05 },
    ],
  },
  overdrive: {
    id: 'overdrive',
    name: 'Overdrive',
    short: 'OD',
    archetype: 'Tube Screamer / Klon',
    description:
      'Warm, touch-sensitive breakup with a focused midrange — the "always-on" sparkle tone worship guitarists love.',
    accent: 'amber',
    params: [
      { id: 'drive', label: 'Drive', min: 0, max: 1, default: 0.35, step: 0.01 },
      { id: 'tone', label: 'Tone', min: 0, max: 1, default: 0.5, step: 0.01 },
      { id: 'level', label: 'Level', min: -12, max: 12, default: 0, step: 0.5, unit: 'dB' },
      { id: 'midHump', label: 'Mid Hump', min: 0, max: 8, default: 4, step: 0.5, unit: 'dB' },
      { id: 'lowCut', label: 'Low Cut', min: 100, max: 500, default: 320, step: 10, unit: 'Hz' },
      { id: 'character', label: 'Character', min: 0, max: 1, default: 0, options: ['Tube Screamer', 'Klon'] },
    ],
  },
  distortion: {
    id: 'distortion',
    name: 'Distortion',
    short: 'DIST',
    archetype: 'Boss BD-2 / Rat',
    description:
      'Bigger, harder-edged gain for bridges and rock songs. Stacks after the overdrive.',
    accent: 'rose',
    params: [
      { id: 'drive', label: 'Drive', min: 0, max: 1, default: 0.5, step: 0.01 },
      { id: 'tone', label: 'Tone', min: 800, max: 12000, default: 4500, step: 100, unit: 'Hz' },
      { id: 'lowCut', label: 'Low Cut', min: 60, max: 400, default: 100, step: 10, unit: 'Hz' },
      { id: 'level', label: 'Level', min: -12, max: 12, default: 0, step: 0.5, unit: 'dB' },
    ],
  },
  phaser: {
    id: 'phaser',
    name: 'Phaser',
    short: 'PHASE',
    archetype: 'MXR Phase 90 / PH-3',
    description: "A slow, swimming sweep — from subtle shimmer to classic '70s whoosh.",
    accent: 'violet',
    params: [
      { id: 'stages', label: 'Stages', min: 0, max: 1, default: 0, options: ['4', '8'] },
      { id: 'rate', label: 'Rate', min: 0.05, max: 3, default: 0.4, step: 0.05, unit: 'Hz' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.7, step: 0.05 },
      { id: 'feedback', label: 'Resonance', min: 0, max: 0.9, default: 0.35, step: 0.05 },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, step: 0.05 },
    ],
  },
  chorus: {
    id: 'chorus',
    name: 'Chorus',
    short: 'CHORUS',
    archetype: 'Boss CH-1 stereo',
    description: 'Makes one instrument sound like two, lush and shimmering. Default subtle-worship setting.',
    accent: 'cyan',
    params: [
      { id: 'rate', label: 'Rate', min: 0.1, max: 6, default: 0.8, step: 0.1, unit: 'Hz' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.35, step: 0.05 },
      { id: 'delayMs', label: 'Delay', min: 5, max: 55, default: 25, step: 1, unit: 'ms' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, step: 0.05 },
      { id: 'tone', label: 'Tone', min: 800, max: 12000, default: 6000, step: 100, unit: 'Hz' },
    ],
  },
  flanger: {
    id: 'flanger',
    name: 'Flanger',
    short: 'FLANGE',
    archetype: 'Boss BF-3',
    description: 'Jet-plane swoosh or gentle motion — dramatic moments and intros.',
    accent: 'violet',
    params: [
      { id: 'rate', label: 'Rate', min: 0.05, max: 5, default: 0.25, step: 0.05, unit: 'Hz' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, step: 0.05 },
      { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, default: 0.5, step: 0.05 },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, step: 0.05 },
    ],
  },
  tremolo: {
    id: 'tremolo',
    name: 'Tremolo',
    short: 'TREM',
    archetype: 'Boss TR-2 / Fender amp',
    description: 'Rhythmic volume pulse — a vintage wobble that sits beautifully under slow songs.',
    accent: 'emerald',
    params: [
      { id: 'rate', label: 'Rate', min: 0.3, max: 12, default: 4, step: 0.1, unit: 'Hz' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, step: 0.05 },
      { id: 'waveform', label: 'Wave', min: 0, max: 2, default: 0, options: ['Sine', 'Triangle', 'Square'] },
    ],
  },
  delay: {
    id: 'delay',
    name: 'Delay',
    short: 'DELAY',
    archetype: 'Boss DD-8 · dotted-8th',
    description:
      'The signature worship echo — play simple eighths, hear hypnotic dotted-eighth patterns (the "U2" sound). Tap tempo included.',
    accent: 'cyan',
    params: [
      { id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, options: ['Digital', 'Analog', 'Tape'] },
      { id: 'subdivision', label: 'Subdivision', min: 0, max: 3, default: 2, options: ['1/4', '1/8', '1/8 dotted', '1/2'] },
      { id: 'bpm', label: 'Tempo', min: 40, max: 240, default: 100, step: 1, unit: 'BPM' },
      { id: 'feedback', label: 'Feedback', min: 0, max: 0.9, default: 0.35, step: 0.05 },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.35, step: 0.05 },
      { id: 'tone', label: 'Tone', min: 500, max: 12000, default: 3500, step: 100, unit: 'Hz' },
    ],
  },
  reverb: {
    id: 'reverb',
    name: 'Reverb',
    short: 'VERB',
    archetype: 'Boss RV-6 / BigSky',
    description: 'Puts the instrument in the room — from tight club to vast cathedral "swell" textures.',
    accent: 'emerald',
    params: [
      { id: 'type', label: 'Type', min: 0, max: 3, default: 1, options: ['Room', 'Hall', 'Plate', 'Spring'] },
      { id: 'decay', label: 'Decay', min: 0.2, max: 8, default: 2.4, step: 0.1, unit: 's' },
      { id: 'predelay', label: 'Predelay', min: 0, max: 150, default: 20, step: 5, unit: 'ms' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, step: 0.05 },
      { id: 'lowCut', label: 'Low Cut', min: 60, max: 400, default: 140, step: 10, unit: 'Hz' },
      { id: 'highCut', label: 'High Cut', min: 1000, max: 16000, default: 8000, step: 250, unit: 'Hz' },
    ],
  },
};

export function defaultFxSlotState(effect: FxEffectDef): FxSlotState {
  const params: Record<string, number> = {};
  for (const p of effect.params) {
    params[p.id] = p.default;
  }
  return { engaged: false, params };
}

export function defaultFxRackState(): ChannelFxRackState {
  const slots = {} as Record<FxSlotId, FxSlotState>;
  for (const id of FX_CHAIN_ORDER) {
    slots[id] = defaultFxSlotState(FX_EFFECTS[id]);
  }
  return { enabled: false, slots };
}

function clampParam(def: FxParamDef, raw: unknown): number {
  const val = typeof raw === 'number' && Number.isFinite(raw) ? raw : def.default;
  const clamped = Math.min(def.max, Math.max(def.min, val));
  return def.step ? Math.round(clamped / def.step) * def.step : clamped;
}

/**
 * Migration-safe normalization: accepts partial/legacy/foreign rack state and
 * returns a fully-valid snapshot (missing knobs fall back to real-world
 * defaults, out-of-range values are clamped).
 */
export function normalizeFxRackState(raw: unknown): ChannelFxRackState {
  const fallback = defaultFxRackState();
  if (!raw || typeof raw !== 'object') return fallback;
  const src = raw as Partial<ChannelFxRackState>;
  const slots = {} as Record<FxSlotId, FxSlotState>;
  for (const id of FX_CHAIN_ORDER) {
    const def = FX_EFFECTS[id];
    const rawSlot = src.slots?.[id];
    if (!rawSlot || typeof rawSlot !== 'object') {
      slots[id] = fallback.slots[id];
      continue;
    }
    const rawParams =
      rawSlot.params && typeof rawSlot.params === 'object' ? rawSlot.params : {};
    const params: Record<string, number> = {};
    for (const p of def.params) {
      params[p.id] = clampParam(p, rawParams[p.id]);
    }
    slots[id] = { engaged: rawSlot.engaged === true, params };
  }
  return { enabled: src.enabled === true, slots };
}

/** Number of engaged pedals (for the rack header + tab badges). */
export function countEngagedFx(state: ChannelFxRackState): number {
  let n = 0;
  for (const id of FX_CHAIN_ORDER) {
    if (state.enabled && state.slots[id]?.engaged) n += 1;
  }
  return n;
}
