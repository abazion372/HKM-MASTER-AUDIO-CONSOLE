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
 */
import type { SpeakerZone } from '../types/audio.ts';

/** Device id of the training/demo "HKM PCIe 8-Out Jack Card (Simulated 7.1)". */
export const SIM_PIE_8OUT_DEVICE_ID = 'sim-pcie-8out-jack-card';
export const SIM_PIE_8OUT_LABEL = 'HKM PCIe 8-Out Jack Card (Simulated 7.1)';

export type OutputJackSlot = 'front-lr' | 'rear-lr' | 'center-lfe' | 'side-lr';

export interface OutputJackEndpoint {
  /** `${parentDeviceId}::jack::${slot}` — stable, persisted on SpeakerZone.outputJackId. */
  jackId: string;
  parentDeviceId: string;
  parentDeviceLabel: string;
  slot: OutputJackSlot;
  /** Silkscreen name, e.g. "FRONT L/R". */
  label: string;
  jackColorName: string;
  jackColorHex: string;
  /** Stream channel indices inside the parent endpoint (WAVEFORMATEXTENSIBLE order). */
  channelIndices: [number, number];
  layout: '5.1' | '7.1';
  /** Total interleaved channels of the parent endpoint (6 or 8). */
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

const SLOT_DEFS: Record<OutputJackSlot, SlotDef> = {
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

/** Slot order for UI rendering (physical jack order on retail cards). */
export const OUTPUT_JACK_SLOT_ORDER: OutputJackSlot[] = ['front-lr', 'rear-lr', 'center-lfe', 'side-lr'];

export function makeJackId(deviceId: string, slot: OutputJackSlot): string {
  return `${deviceId}::jack::${slot}`;
}

export function parseJackId(jackId?: string | null): { deviceId: string; slot: OutputJackSlot } | null {
  if (!jackId) return null;
  const parts = jackId.split('::jack::');
  if (parts.length !== 2) return null;
  const slot = parts[1] as OutputJackSlot;
  if (!SLOT_DEFS[slot]) return null;
  return { deviceId: parts[0], slot };
}

/**
 * Explode one enumerated output device into its discrete jack endpoints.
 * Returns [] for stereo-only devices (channelCount < 4) — those keep the
 * classic "one device = one stereo output" behaviour.
 */
export function buildJackEndpoints(
  parent: { deviceId: string; label: string },
  channelCount: number,
  simulated = false
): OutputJackEndpoint[] {
  if (channelCount < 4) return [];
  const layout: '5.1' | '7.1' = channelCount >= 8 ? '7.1' : '5.1';
  const endpoints: OutputJackEndpoint[] = [];
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

/** Default zone-role → jack-slot patch map used by AUTO-ASSIGN (church install order). */
export const ZONE_ROLE_DEFAULT_JACK: Partial<Record<SpeakerZone['role'], OutputJackSlot>> = {
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
