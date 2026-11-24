/**
 * Real-world console input source-mode model.
 *
 * Models the physical MIC / LINE / INST selector of a professional console input
 * strip (Allen & Heath ZED, Soundcraft, Mackie Onyx) plus the Hi-Z "INST"
 * engagement found on audio interfaces (Focusrite Scarlett, MOTU M-Series).
 *
 * The HKM preamp engine stores one engine-domain gain value per channel
 * (`gainDb`, 0..+60 dB, digital unity at +24). Each input mode re-scales the
 * *displayed* gain domain exactly like the silkscreen scale on a real console:
 *
 *   MIC  : +0 .. +60 dB mic preamp gain (unity +24, phantom available)
 *   LINE : −12 .. +12 dB line trim around unity (jack TRS domain, no phantom)
 *   INST : +8 .. +55 dB instrument gain (Hi-Z ≥1MΩ, phantom hard-locked —
 *          sending +48V into a guitar or an unprotected DI can destroy it)
 */
import type { ChannelInputMode, InputChannel } from '../types/audio.ts';

export interface InputModeSpec {
  id: ChannelInputMode;
  shortLabel: string;
  fullLabel: string;
  /** Engine-domain preamp gain bounds (stored `gainDb`). */
  gainMin: number;
  gainMax: number;
  /** Digital unity point in engine-domain dB (preampDb = gainDb − 24 in the DSP chain). */
  unityGainDb: number;
  /** How the knob readout renders the engine value. */
  formatGain: (gainDb: number) => string;
  /** Nominal RMS target (dBFS) used by gain-staging intelligence. */
  stagingTargetRmsDb: number;
  /** +48V phantom physically available on this input domain? */
  phantomAllowed: boolean;
  /** Hardware-domain hint shown on the strip. */
  domainNote: string;
}

export const INPUT_MODES: Record<ChannelInputMode, InputModeSpec> = {
  mic: {
    id: 'mic',
    shortLabel: 'MIC',
    fullLabel: 'Microphone (XLR, balanced, +48V capable)',
    gainMin: 0,
    gainMax: 60,
    unityGainDb: 24,
    formatGain: (g) => `+${Math.round(g)}`,
    stagingTargetRmsDb: -18,
    phantomAllowed: true,
    domainNote: 'Mic level · −56..−29 dBu',
  },
  line: {
    id: 'line',
    shortLabel: 'LINE',
    fullLabel: 'Line Level (TRS jack, balanced)',
    gainMin: 12,
    gainMax: 36,
    unityGainDb: 24,
    formatGain: (g) => {
      const trim = Math.round(g - 24);
      return trim > 0 ? `+${trim}` : `${trim}`;
    },
    stagingTargetRmsDb: -18,
    phantomAllowed: false,
    domainNote: 'Line level · +4 dBu / −10 dBV',
  },
  inst: {
    id: 'inst',
    shortLabel: 'INST',
    fullLabel: 'Instrument Hi-Z (guitar / bass, ¼" jack, ≥1MΩ)',
    gainMin: 8,
    gainMax: 55,
    unityGainDb: 24,
    formatGain: (g) => `+${Math.round(g)}`,
    stagingTargetRmsDb: -16,
    phantomAllowed: false,
    domainNote: 'Hi-Z 1MΩ · −20..0 dBu',
  },
};

export const INPUT_MODE_ORDER: ChannelInputMode[] = ['mic', 'line', 'inst'];

/** Normalize a persisted channel that predates the input-mode switch. */
export function getInputMode(ch: Pick<InputChannel, 'inputMode'>): ChannelInputMode {
  const mode = ch.inputMode;
  return mode === 'line' || mode === 'inst' ? mode : 'mic';
}

/** Clamp a stored preamp gain into the selected mode's real-world scale. */
export function clampGainForMode(gainDb: number, mode: ChannelInputMode): number {
  const spec = INPUT_MODES[mode];
  return Math.max(spec.gainMin, Math.min(spec.gainMax, gainDb));
}

/** Staging target for a channel, honoring its input mode. */
export function stagingTargetFor(ch: InputChannel): number {
  return INPUT_MODES[getInputMode(ch)].stagingTargetRmsDb;
}

/**
 * Real-world guitar rig checklist shown when a channel runs in INST mode.
 * Mirrors the setup discipline of a professional stage patch.
 */
export const INSTRUMENT_RIG_CHECKLIST: string[] = [
  'Plug the guitar into the interface ¼" INST / Hi-Z jack (engage the INST switch) — a ~1MΩ input preserves pickup top-end. Long cable runs: use an active DI into a MIC input instead.',
  'Never send +48V phantom into an instrument or an unprotected passive DI — HKM auto-disengages and locks phantom on INST channels.',
  'Strum your loudest and set the interface gain so peaks land around −6 dBFS; single-coil pickups sit far quieter than humbuckers or active preamps.',
  'Hearing 50/60 Hz hum? Try the DI Ground-Lift switch and replace unbalanced TS cables before reaching for EQ.',
  'Use the −20 dB PAD if an active bass or hot pedalboard overdrives the input — exactly like a real console pad.',
];
