/**
 * Discrete output jack topology — professional multi-channel sound-card model.
 *
 * RESEARCH CONTEXT (real world):
 * On Windows, a 5.1/7.1 PCIe or onboard sound card (Realtek HD Audio, ASUS
 * Xonar, Creative Sound Blaster, ESI/M-Audio PCIe) usually exposes ONE WASAPI
 * render endpoint whose stream carries 6 or 8 interleaved channels. The
 * physical jack ports are NOT separate endpoints — they are fixed channel
 * positions inside that one stream, following the WAVEFORMATEXTENSIBLE
 * channel order used by every Windows driver:
 *
 *      FL  FR  FC  LFE  BL  BR  SL  SR
 *       0   1   2   3    4   5   6   7
 *
 * The industry-standard HD Audio jack colour code (silkscreened on every
 * retail card and enforced by the Realtek/Intel HDA spec) is:
 *
 *      GREEN  jack → Front L/R      (channels 0/1)  — main stereo pair
 *      ORANGE jack → Center / Sub   (channels 2/3)  — FC + LFE
 *      BLACK  jack → Rear L/R       (channels 4/5)  — BL + BR (surround)
 *      GREY   jack → Side L/R       (channels 6/7)  — SL + SR (7.1 only)
 *
 * So "separating the jacks professionally" = open the ONE endpoint in
 * discrete multichannel mode and route an independent mix onto each channel
 * pair, exactly like a matrixed zone output card. Requirements for this to
 * be conflict-free:
 *
 *   1. Windows Speaker Configuration for the device must be set to 5.1/7.1
 *      (Sound Control Panel) — otherwise the driver folds everything down to
 *      the front pair. HKM surfaces a shortcut to that settings page.
 *   2. Exactly ONE zone per jack slot — enforced by the assignment UI
 *      (selecting a zone onto an occupied jack swaps the previous zone off)
 *      and re-enforced in the audio engine (first-wins guard).
 *   3. The engine addresses the destination with channelInterpretation
 *      'discrete' so the browser performs no speaker down-mix magic and the
 *      channels map 1:1 onto the device stream (jack conductors).
 *
 * Pro-audio cards that expose every jack pair as an individual ASIO stream
 * (RME, Focusrite PCIe) are the exclusive-mode variant of the same topology;
 * that path is reserved for the native WASAPI/ASIO engine (v2) — this module
 * drives the browser Web Audio engine used by both the web and desktop app.
 *
 * N-CHANNEL EXTENSION: pro cards and virtual soundcards (RME HDSPe, M-Audio
 * Delta 1010, Dante 16-ch) expose 10-16 output channels in ONE stream. Every
 * complete channel pair beyond index 7 becomes a generated `aux-N` slot
 * (aux-1 = channels 8/9, aux-2 = 10/11, …) with its own silkscreen identity
 * (odd aux jacks teal, even aux jacks violet). Named-slot jackIds and channel
 * indices are byte-for-byte backwards compatible with all persisted
 * `SpeakerZone.outputJackId` values.
 */
import type { SpeakerZone } from '../types/audio.ts';

/** Device id of the training/demo "HKM PCIe 8-Out Jack Card (Simulated 7.1)". */
export const SIM_PIE_8OUT_DEVICE_ID = 'sim-pcie-8out-jack-card';
export const SIM_PIE_8OUT_LABEL = 'HKM PCIe 8-Out Jack Card (Simulated 7.1)';

/** The four industry HDA colour-coded slots shared by every 5.1/7.1 card. */
export type NamedJackSlot = 'front-lr' | 'rear-lr' | 'center-lfe' | 'side-lr';

/**
 * Any routable jack slot: the four named HDA slots plus generated `aux-N`
 * pairs (aux-1 = channels 8/9, aux-2 = 10/11, …) for >8-channel pro cards.
 */
export type OutputJackSlot = NamedJackSlot | `aux-${number}`;

export interface OutputJackEndpoint {
  /** `${parentDeviceId}::jack::${slot}` — stable, persisted on SpeakerZone.outputJackId. */
  jackId: string;
  parentDeviceId: string;
  parentDeviceLabel: string;
  slot: OutputJackSlot;
  /** Silkscreen name, e.g. "FRONT L/R" or "AUX 1 L/R". */
  label: string;
  jackColorName: string;
  jackColorHex: string;
  /** Stream channel indices inside the parent endpoint (WAVEFORMATEXTENSIBLE order). */
  channelIndices: [number, number];
  /** '5.1' | '7.1' for standard cards; `${channelCount}-CH` (e.g. '10-CH', '16-CH') beyond 8 channels. */
  layout: string;
  /** Total interleaved channels of the parent endpoint (6, 8, 10 … 32). */
  channelCount: number;
  /** True for the training-mode simulated card (no physical device behind it). */
  simulated: boolean;
}

interface SlotDef {
  label: string;
  colorName: string;
  colorHex: string;
  fiveDotOne: [number, number] | null;
  sevenDotOne: [number, number];
}

const SLOT_DEFS: Record<NamedJackSlot, SlotDef> = {
  'front-lr': {
    label: 'FRONT L/R',
    colorName: 'Green',
    colorHex: '#22C55E',
    fiveDotOne: [0, 1],
    sevenDotOne: [0, 1],
  },
  'center-lfe': {
    label: 'CENTER/SUB',
    colorName: 'Orange',
    colorHex: '#F59E0B',
    fiveDotOne: [2, 3],
    sevenDotOne: [2, 3],
  },
  'rear-lr': {
    label: 'REAR L/R',
    colorName: 'Black',
    colorHex: '#475569',
    fiveDotOne: [4, 5],
    sevenDotOne: [4, 5],
  },
  'side-lr': {
    label: 'SIDE L/R',
    colorName: 'Grey',
    colorHex: '#94A3B8',
    fiveDotOne: null,
    sevenDotOne: [6, 7],
  },
};

/** Named-slot display order for UI rendering (physical jack order on retail cards). */
export const OUTPUT_JACK_SLOT_ORDER: NamedJackSlot[] = ['front-lr', 'rear-lr', 'center-lfe', 'side-lr'];

/** `aux-N` slot ids are 1-based: aux-1 = channels 8/9, aux-2 = 10/11, … */
const AUX_SLOT_PATTERN = /^aux-([1-9]\d*)$/;

function isNamedSlot(slot: string): slot is NamedJackSlot {
  return slot === 'front-lr' || slot === 'rear-lr' || slot === 'center-lfe' || slot === 'side-lr';
}

/** Parse an `aux-N` slot id into its 1-based N (null when not a valid aux id). */
function parseAuxSlotNumber(slot: string): number | null {
  const match = AUX_SLOT_PATTERN.exec(slot);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Visual identity of a generated aux slot: odd aux jacks teal, even violet. */
function auxSlotDef(n: number): { label: string; colorName: string; colorHex: string } {
  const teal = n % 2 === 1;
  return {
    label: `AUX ${n} L/R`,
    colorName: teal ? 'Teal' : 'Violet',
    colorHex: teal ? '#14B8A6' : '#A78BFA',
  };
}

/** First stream channel index of the `aux-N` pair (aux-1 starts at channel 8). */
function auxChannelBase(n: number): number {
  return 2 * n + 6;
}

/** The HDA silkscreen palette shared by the jack model and native colour hints. */
const HDA_JACK_COLORS: Array<{ colorName: string; colorHex: string }> = [
  { colorName: 'Green', colorHex: '#22C55E' },
  { colorName: 'Orange', colorHex: '#F59E0B' },
  { colorName: 'Black', colorHex: '#475569' },
  { colorName: 'Grey', colorHex: '#94A3B8' },
  { colorName: 'Teal', colorHex: '#14B8A6' },
  { colorName: 'Violet', colorHex: '#A78BFA' },
];

/**
 * Map a native IKsJackDescription colour (0x00RRGGBB) onto the nearest HDA
 * silkscreen colour of the jack model — best-effort refinement of probed
 * jack labels when the Rust shell exposes real jack metadata.
 */
export function nativeColorToHda(colorRgb: number): { colorName: string; colorHex: string } {
  const r = (colorRgb >> 16) & 0xff;
  const g = (colorRgb >> 8) & 0xff;
  const b = colorRgb & 0xff;
  let best = HDA_JACK_COLORS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of HDA_JACK_COLORS) {
    const cr = Number.parseInt(candidate.colorHex.slice(1, 3), 16);
    const cg = Number.parseInt(candidate.colorHex.slice(3, 5), 16);
    const cb = Number.parseInt(candidate.colorHex.slice(5, 7), 16);
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return { colorName: best.colorName, colorHex: best.colorHex };
}

/**
 * Single source of truth for a slot's stream channel indices inside a parent
 * endpoint of `channelCount` channels (WAVEFORMATEXTENSIBLE order). Named
 * slots follow the 5.1 (< 8) / 7.1 (>= 8) layouts; `aux-N` maps to the pair
 * [2N+6, 2N+7]. Returns null when the slot does not exist in that layout
 * (side-lr on 5.1, aux pairs beyond the reported channel count).
 */
export function slotChannelIndices(
  slot: OutputJackSlot,
  channelCount: number
): [number, number] | null {
  if (isNamedSlot(slot)) {
    const def = SLOT_DEFS[slot];
    return channelCount >= 8 ? def.sevenDotOne : def.fiveDotOne;
  }
  const n = parseAuxSlotNumber(slot);
  if (n === null) return null;
  const base = auxChannelBase(n);
  return channelCount >= base + 2 ? [base, base + 1] : null;
}

/**
 * Every jack slot that exists on a parent endpoint of `channelCount` channels,
 * in physical card order (front, rear, center/sub, side, then aux-1..N).
 * 5.1 layouts drop side-lr; slots whose channel pair does not fully fit
 * inside the reported channel count are omitted.
 */
export function orderedJackSlots(channelCount: number): OutputJackSlot[] {
  const slots: OutputJackSlot[] = [];
  for (const slot of OUTPUT_JACK_SLOT_ORDER) {
    const indices = slotChannelIndices(slot, channelCount);
    if (indices && indices[1] < channelCount) slots.push(slot);
  }
  for (let n = 1; ; n += 1) {
    const indices = slotChannelIndices(`aux-${n}`, channelCount);
    if (!indices) break;
    slots.push(`aux-${n}`);
  }
  return slots;
}

export function makeJackId(deviceId: string, slot: OutputJackSlot): string {
  return `${deviceId}::jack::${slot}`;
}

export function parseJackId(jackId?: string | null): { deviceId: string; slot: OutputJackSlot } | null {
  if (!jackId) return null;
  const parts = jackId.split('::jack::');
  if (parts.length !== 2) return null;
  const slot = parts[1];
  // Named HDA slots or generated aux pairs (aux-N, N >= 1) — every legacy
  // `${deviceId}::jack::${slot}` id keeps parsing with identical indices.
  if (isNamedSlot(slot)) return { deviceId: parts[0], slot };
  const auxN = parseAuxSlotNumber(slot);
  if (auxN !== null) return { deviceId: parts[0], slot: `aux-${auxN}` };
  return null;
}

/**
 * Explode one enumerated output device into its discrete jack endpoints.
 * Returns [] for stereo-only devices (channelCount < 4) — those keep the
 * classic "one device = one stereo output" behaviour. Standard 5.1/7.1 cards
 * (<= 8 channels) explode into the named HDA slots exactly as before;
 * >8-channel pro cards add one `aux-N` pair per complete even channel pair
 * from channel 8 upward. Odd channel counts leave a final unpaired channel —
 * it is skipped (jacks are stereo conductor pairs; a lone channel has no
 * jack to land on).
 */
export function buildJackEndpoints(
  parent: { deviceId: string; label: string },
  channelCount: number,
  simulated = false
): OutputJackEndpoint[] {
  if (channelCount < 4) return [];
  const endpoints: OutputJackEndpoint[] = [];

  if (channelCount <= 8) {
    // Standard 5.1/7.1 card — byte-for-byte the legacy named-slot layout.
    const layout: '5.1' | '7.1' = channelCount >= 8 ? '7.1' : '5.1';
    for (const slot of OUTPUT_JACK_SLOT_ORDER) {
      const def = SLOT_DEFS[slot];
      const indices = layout === '7.1' ? def.sevenDotOne : def.fiveDotOne;
      if (!indices) continue;
      endpoints.push({
        jackId: makeJackId(parent.deviceId, slot),
        parentDeviceId: parent.deviceId,
        parentDeviceLabel: parent.label,
        slot,
        label: def.label,
        jackColorName: def.colorName,
        jackColorHex: def.colorHex,
        channelIndices: indices,
        layout,
        channelCount,
        simulated,
      });
    }
    return endpoints;
  }

  // >8-channel pro card: named slots at their 7.1 positions plus generated
  // aux pairs for every complete channel pair from channel 8 up.
  const layout = `${channelCount}-CH`;
  for (const slot of OUTPUT_JACK_SLOT_ORDER) {
    const def = SLOT_DEFS[slot];
    endpoints.push({
      jackId: makeJackId(parent.deviceId, slot),
      parentDeviceId: parent.deviceId,
      parentDeviceLabel: parent.label,
      slot,
      label: def.label,
      jackColorName: def.colorName,
      jackColorHex: def.colorHex,
      channelIndices: def.sevenDotOne,
      layout,
      channelCount,
      simulated,
    });
  }
  for (let n = 1; auxChannelBase(n) + 1 < channelCount; n += 1) {
    const def = auxSlotDef(n);
    endpoints.push({
      jackId: makeJackId(parent.deviceId, `aux-${n}`),
      parentDeviceId: parent.deviceId,
      parentDeviceLabel: parent.label,
      slot: `aux-${n}`,
      label: def.label,
      jackColorName: def.colorName,
      jackColorHex: def.colorHex,
      channelIndices: [auxChannelBase(n), auxChannelBase(n) + 1],
      layout,
      channelCount,
      simulated,
    });
  }
  return endpoints;
}

/**
 * Default zone-role → jack-slot patch map used by AUTO-ASSIGN (church install
 * order). Named slots only — generated aux slots carry no default role and
 * stay manual-assign only.
 */
export const ZONE_ROLE_DEFAULT_JACK: Partial<Record<SpeakerZone['role'], NamedJackSlot>> = {
  'main-lr': 'front-lr',
  'sub': 'center-lfe',
  'rear-fill': 'rear-lr',
  'overflow': 'rear-lr',
  'center': 'center-lfe',
  'stage-monitor': 'side-lr',
};

/**
 * Conflict-free automatic zone→jack assignment: each slot receives at most one
 * zone (roles matched by the church-install defaults above; unmatched zones
 * stay unassigned). Returns only the zone patches that change something.
 */
export function buildAutoJackAssignments(
  zones: SpeakerZone[],
  jacks: OutputJackEndpoint[]
): Array<{ zoneId: string; patch: Partial<SpeakerZone> }> {
  const patches: Array<{ zoneId: string; patch: Partial<SpeakerZone> }> = [];
  const takenSlots = new Set<OutputJackSlot>();

  // Slots already manually assigned win over auto-assignment.
  for (const zone of zones) {
    const parsed = parseJackId(zone.outputJackId);
    if (parsed && parsed.deviceId === (jacks[0]?.parentDeviceId ?? '')) {
      takenSlots.add(parsed.slot);
    }
  }

  for (const jack of jacks) {
    if (takenSlots.has(jack.slot)) continue;
    const wantedRole = (Object.keys(ZONE_ROLE_DEFAULT_JACK) as SpeakerZone['role'][]).find(
      (role) => ZONE_ROLE_DEFAULT_JACK[role] === jack.slot
    );
    if (!wantedRole) continue;
    const candidate = zones.find(
      (z) =>
        z.role === wantedRole &&
        !(z.outputJackId && z.outputJackId !== makeJackId(jack.parentDeviceId, jack.slot))
    );
    if (candidate) {
      takenSlots.add(jack.slot);
      if (candidate.outputJackId !== jack.jackId) {
        patches.push({ zoneId: candidate.id, patch: { outputJackId: jack.jackId } });
      }
    }
  }
  return patches;
}

/**
 * One zone per jack — the hard interlock. Zones later in the array lose.
 * Returns patches clearing conflicted zones (applied by the engine guard and
 * surfaced by the UI as an automatic swap).
 */
export function findJackConflicts(zones: SpeakerZone[]): SpeakerZone[] {
  const bySlot = new Map<string, SpeakerZone>();
  const losers: SpeakerZone[] = [];
  for (const zone of zones) {
    const parsed = parseJackId(zone.outputJackId);
    if (!parsed) continue;
    const key = `${parsed.deviceId}::${parsed.slot}`;
    const existing = bySlot.get(key);
    if (existing) {
      losers.push(zone);
    } else {
      bySlot.set(key, zone);
    }
  }
  return losers;
}
