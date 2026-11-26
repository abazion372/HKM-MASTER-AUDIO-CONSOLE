import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_BASS_DI_CONFIG,
  DEFAULT_DSP_CONFIG,
  DEFAULT_SPEAKER_ZONES,
  HARDWARE_CATALOG,
  INITIAL_ACOUSTIC_MEASUREMENT,
  SERVICE_PRESETS,
  buildChannelsForDevice,
} from '../hkm/data/hardwareCatalog.ts';

export interface RemoteAccessState {
  sessionToken: string;
  pinEnabled: boolean;
  pinCode: string;
  allowGainAdjustment: boolean;
  allowMuteControl: boolean;
  allowMasterTrim: boolean;
  lanHostOverride: string;
  createdAt: string;
}

export interface PersistedState {
  /** Store format version — bump on breaking shape changes so hydration
   * code can migrate deliberately instead of guessing. */
  schemaVersion?: number;
  venue: {
    organization: string;
    venueName: string;
    roomName: string;
    targetPlatform: 'windows' | 'macos' | 'linux';
    driver: string;
    sampleRate: number;
    bufferSize: number;
    activeDeviceId: string;
  };
  channels: Array<Record<string, unknown>>;
  dsp: Record<string, unknown>;
  activePresetId: string;
  broadcastDsp: Record<string, unknown>;
  zones: Array<Record<string, unknown>>;
  obsStatus: Record<string, unknown>;
  measurement: Record<string, unknown>;
  bassDi: Record<string, unknown>;
  emergencyMuted: boolean;
  findings: Array<Record<string, unknown>>;
  remoteAccess: RemoteAccessState;
  versions: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  auditEvents: Array<Record<string, unknown>>;
  midiMappings?: Array<Record<string, unknown>>;
  automationSnapshots?: Array<Record<string, unknown>>;
  keyboardShortcuts?: Array<Record<string, unknown>>;
  customPresets?: Array<Record<string, unknown>>;
  deviceProfiles?: Record<string, Record<string, unknown>>;
  /** Set once the operator dismisses the first-run guide. Absent = fresh
   * install (or pre-guide upgrade) → guide should be shown once. */
  firstRunCompleted?: boolean;
}

/** Current persisted-state schema. 1 = everything before this field existed;
 * 2 = schemaVersion + firstRunCompleted introduced (v1.2.0). */
export const CURRENT_SCHEMA_VERSION = 2;

export function generateToken(): string {
  return crypto.randomBytes(12).toString('base64url');
}

export const DATA_DIR = process.env.HKM_DATA_DIR
  ? path.resolve(process.env.HKM_DATA_DIR)
  : path.join(process.cwd(), 'db');
export const STATE_FILE = path.join(DATA_DIR, 'hkm-state.json');

export function buildDefaultState(): PersistedState {
  const defaultDevice = HARDWARE_CATALOG[0];
  const defaultPreset = SERVICE_PRESETS[0];
  return {
    venue: {
      organization: 'Grace Community Fellowship',
      venueName: 'Grace Community Fellowship',
      roomName: 'Main Sanctuary',
      targetPlatform: 'windows',
      driver: 'ASIO',
      sampleRate: defaultDevice.defaultSampleRate,
      bufferSize: defaultDevice.defaultBufferSize,
      activeDeviceId: defaultDevice.id,
    },
    channels: buildChannelsForDevice(defaultDevice) as unknown as Array<Record<string, unknown>>,
    dsp: DEFAULT_DSP_CONFIG as unknown as Record<string, unknown>,
    activePresetId: defaultPreset.id,
    broadcastDsp: defaultPreset.broadcastDsp as unknown as Record<string, unknown>,
    zones: DEFAULT_SPEAKER_ZONES as unknown as Array<Record<string, unknown>>,
    obsStatus: {
      connected: false,
      websocketUrl: 'ws://127.0.0.1:4455',
      activeScene: 'Sanctuary Wide + Preacher',
      scenes: [
        'Pre-Service Countdown',
        'Worship Full Band',
        'Sanctuary Wide + Preacher',
        'Pulpit Close-Up',
      ],
      streaming: false,
      recording: false,
      bitrateKbps: 0,
      droppedFrames: 0,
      cpuUsagePct: 0,
      audioMonitorMode: 'Monitor Off',
      syncWarning: false,
    },
    measurement: INITIAL_ACOUSTIC_MEASUREMENT as unknown as Record<string, unknown>,
    bassDi: DEFAULT_BASS_DI_CONFIG as unknown as Record<string, unknown>,
    emergencyMuted: false,
    findings: [],
    remoteAccess: {
      sessionToken: generateToken(),
      pinEnabled: false,
      pinCode: '2026',
      allowGainAdjustment: true,
      allowMuteControl: true,
      allowMasterTrim: true,
      lanHostOverride: '',
      createdAt: new Date().toISOString(),
    },
    versions: [],
    diagnostics: [],
    auditEvents: [
      {
        id: 'evt-init-1',
        timestamp: new Date().toISOString(),
        actor: 'System Watchdog',
        action: 'Local Store Initialized',
        detail: 'JSON store, WebSocket sync engine, and remote companion subsystem active.',
        authority: 'system',
      },
    ],
    automationSnapshots: [],
  };
}

export function hydrateWithDefaults(raw: Partial<PersistedState>): PersistedState {
  const defaults = buildDefaultState();
  const venue = { ...defaults.venue, ...(raw.venue ?? {}) };
  const activeDevice =
    HARDWARE_CATALOG.find((d) => d.id === venue.activeDeviceId) ?? HARDWARE_CATALOG[0];
  const rawChannels =
    Array.isArray(raw.channels) && raw.channels.length > 0
      ? raw.channels
      : (buildChannelsForDevice(activeDevice) as unknown as Array<Record<string, unknown>>);
  const channels = rawChannels.map((ch) => ({
    ...ch,
    levelDb: -96,
    peakDb: -96,
    noiseFloorDb: -96,
  }));

  return {
    ...defaults,
    ...raw,
    schemaVersion: Math.min(Number(raw.schemaVersion ?? 1) || 1, CURRENT_SCHEMA_VERSION),
    venue,
    channels,
    dsp: raw.dsp && typeof raw.dsp === 'object' ? raw.dsp : defaults.dsp,
    activePresetId: raw.activePresetId || defaults.activePresetId,
    broadcastDsp:
      raw.broadcastDsp && typeof raw.broadcastDsp === 'object'
        ? raw.broadcastDsp
        : defaults.broadcastDsp,
    zones: Array.isArray(raw.zones) && raw.zones.length > 0 ? raw.zones : defaults.zones,
    obsStatus:
      raw.obsStatus && typeof raw.obsStatus === 'object' ? raw.obsStatus : defaults.obsStatus,
    measurement:
      raw.measurement && typeof raw.measurement === 'object'
        ? raw.measurement
        : defaults.measurement,
    bassDi: raw.bassDi && typeof raw.bassDi === 'object' ? raw.bassDi : defaults.bassDi,
    emergencyMuted: Boolean(raw.emergencyMuted),
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    remoteAccess: {
      ...defaults.remoteAccess,
      ...(raw.remoteAccess ?? {}),
      sessionToken: raw.remoteAccess?.sessionToken || defaults.remoteAccess.sessionToken,
    },
    versions: Array.isArray(raw.versions) ? raw.versions : [],
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
    auditEvents:
      Array.isArray(raw.auditEvents) && raw.auditEvents.length > 0
        ? raw.auditEvents
        : defaults.auditEvents,
    midiMappings: Array.isArray(raw.midiMappings) ? raw.midiMappings : undefined,
    automationSnapshots: Array.isArray(raw.automationSnapshots) ? raw.automationSnapshots : [],
    keyboardShortcuts: Array.isArray(raw.keyboardShortcuts) ? raw.keyboardShortcuts : undefined,
    customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : undefined,
    deviceProfiles:
      raw.deviceProfiles && typeof raw.deviceProfiles === 'object'
        ? raw.deviceProfiles
        : undefined,
  };
}

interface StoreCache {
  state: PersistedState | null;
  mtimeMs: number;
  /** Digest of the last payload actually written to disk (write dedup). */
  lastWrittenHash: string | null;
  /** Set when the last ensureStore() had to recover from a corrupt file —
   * surfaced once via /api/state so the operator is told, never silently. */
  lastLoadCorrupt: boolean;
}

const globalStore = globalThis as unknown as { __hkmStoreCache?: StoreCache };
const cache: StoreCache = globalStore.__hkmStoreCache ?? {
  state: null,
  mtimeMs: 0,
  lastWrittenHash: null,
  lastLoadCorrupt: false,
};
globalStore.__hkmStoreCache = cache;

function digestJson(json: string): string {
  return crypto.createHash('sha1').update(json).digest('hex');
}

function writeAtomic(state: PersistedState, force = false): void {
  // Compact serialization: the state file is machine-managed runtime data
  // (never hand-edited), so skipping pretty-printing cuts ~35% of the bytes
  // written per save — significant for 24/7 disk-wear and IO churn.
  const json = JSON.stringify(state);

  // Skip the write entirely when the serialized payload is byte-identical to
  // what is already on disk. Several call paths (hydration re-syncs, repeated
  // patches that land on identical values) would otherwise rewrite the full
  // ~250KB file with unchanged content.
  if (!force && cache.lastWrittenHash !== null && digestJson(json) === cache.lastWrittenHash) {
    cache.state = state;
    return;
  }

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpFile = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, json, 'utf8');
  try {
    fs.renameSync(tmpFile, STATE_FILE);
  } catch {
    fs.rmSync(tmpFile, { force: true });
    // Cross-device rename fallback: direct write
    fs.writeFileSync(STATE_FILE, json, 'utf8');
  }
  cache.state = state;
  cache.lastWrittenHash = digestJson(json);
  try {
    cache.mtimeMs = fs.statSync(STATE_FILE).mtimeMs;
  } catch {
    cache.mtimeMs = Date.now();
  }
}

class LocalAudioStore {
  /** Always returns fresh state: re-reads the file when another process wrote it. */
  public ensureStore(): PersistedState {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(STATE_FILE);
    } catch {
      stat = null;
    }

    if (stat && cache.state && stat.mtimeMs === cache.mtimeMs) {
      return cache.state;
    }

    if (stat) {
      try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<PersistedState>;
        const hydrated = hydrateWithDefaults(raw);
        cache.state = hydrated;
        cache.mtimeMs = stat.mtimeMs;
        cache.lastLoadCorrupt = false;
        // Another process (audio-ws mini-service) may have rewritten the file;
        // reset our write-dedup digest so the next save is not incorrectly
        // considered identical to our own previous payload.
        cache.lastWrittenHash = null;
        return hydrated;
      } catch {
        // Corrupt file — preserve the evidence before reseeding. The previous
        // behaviour (silent overwrite with defaults) destroyed the operator's
        // only copy of a mid-service mix with no trace and no warning.
        cache.lastLoadCorrupt = true;
        try {
          const backupPath = path.join(
            DATA_DIR,
            `hkm-state.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
          );
          fs.copyFileSync(STATE_FILE, backupPath);
        } catch {
          // Even the backup failing must not block recovery — reseeding still
          // gives the operator a working console instead of a dead one.
        }
      }
    }

    const seeded = buildDefaultState();
    seeded.schemaVersion = CURRENT_SCHEMA_VERSION;
    writeAtomic(seeded, true);
    return seeded;
  }

  /** True exactly once after a corrupt-file recovery; the state route relays
   * it so the console can warn the operator and point at the .bak file. */
  public consumeCorruptFlag(): boolean {
    const flag = cache.lastLoadCorrupt;
    cache.lastLoadCorrupt = false;
    return flag;
  }

  public saveStore(state: PersistedState): void {
    writeAtomic(state);
  }

  /** Immediate, non-deduplicated write for security-critical updates. */
  public saveStoreNow(state: PersistedState): void {
    writeAtomic(state, true);
  }

  public patchChannel(channelId: string, patch: Record<string, unknown>): PersistedState {
    const state = this.ensureStore();
    state.channels = state.channels.map((ch) => (ch.id === channelId ? { ...ch, ...patch } : ch));
    this.saveStore(state);
    return state;
  }

  public patchMaster(patch: { inputTrimDb?: number; emergencyMuted?: boolean }): PersistedState {
    const state = this.ensureStore();
    if (typeof patch.inputTrimDb === 'number') {
      state.dsp = { ...state.dsp, inputTrimDb: patch.inputTrimDb };
    }
    if (typeof patch.emergencyMuted === 'boolean') {
      state.emergencyMuted = patch.emergencyMuted;
    }
    this.saveStore(state);
    return state;
  }

  public getDeviceProfile(deviceId: string): Record<string, unknown> | null {
    const state = this.ensureStore();
    const profiles = (state.deviceProfiles ?? {}) as Record<string, Record<string, unknown>>;
    const profile = profiles[deviceId];
    if (!profile) return null;
    return profile;
  }

  public saveDeviceProfile(
    deviceId: string,
    payload: Record<string, unknown>
  ): { ok: boolean; updatedAt: string } {
    const state = this.ensureStore();
    const profiles = { ...(state.deviceProfiles ?? {}) } as Record<string, Record<string, unknown>>;
    profiles[deviceId] = { ...payload, updatedAt: new Date().toISOString() };
    state.deviceProfiles = profiles;
    this.saveStore(state);
    return { ok: true, updatedAt: new Date().toISOString() };
  }

  public getStats() {
    const state = this.ensureStore();
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(STATE_FILE).size;
    } catch {
      fileBytes = 0;
    }
    return {
      engine: 'json-store+ws-sync',
      storeFile: 'db/hkm-state.json',
      schemaVersion: state.schemaVersion ?? 1,
      fileBytes,
      channelsCount: state.channels.length,
      zonesCount: state.zones.length,
      versionsCount: state.versions.length,
      auditCount: state.auditEvents.length,
      automationsCount: state.automationSnapshots?.length ?? 0,
    };
  }
}

export const audioStore = new LocalAudioStore();
