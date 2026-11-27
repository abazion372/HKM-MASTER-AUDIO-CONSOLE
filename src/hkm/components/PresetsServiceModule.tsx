import React, { useState } from 'react';
import { Download, Layers, RotateCcw, Save, Upload } from 'lucide-react';
import type {
  ConfigurationVersion,
  DspConfig,
  HardwareDevice,
  ObsStatus,
  ServicePreset,
} from '../types/audio.ts';
import { ConsolePushButton } from './StudioControls.tsx';

interface PresetsServiceModuleProps {
  device: HardwareDevice;
  dsp: DspConfig;
  obsStatus: ObsStatus;
  onUpdateObs: (patch: Partial<ObsStatus>) => void;
  presets: ServicePreset[];
  activePreset: ServicePreset;
  onSelectPreset: (preset: ServicePreset) => void;
  versions: ConfigurationVersion[];
  onSaveVersion: (summary: string) => void;
  onRollbackVersion: (version: ConfigurationVersion) => void;
  onImportPresetJson: (preset: ServicePreset) => void;
}

const SERVICE_ORDER_CUES = [
  { id: 'cue-1', order: '01', name: 'Pre-Service Countdown', presetId: 'preset-sunday', obsScene: 'Pre-Service Countdown' },
  { id: 'cue-2', order: '02', name: 'Praise & Worship Full Band', presetId: 'preset-worship', obsScene: 'Worship Full Band' },
  { id: 'cue-3', order: '03', name: 'Choir / Special Song', presetId: 'preset-choir', obsScene: 'Worship Full Band' },
  { id: 'cue-4', order: '04', name: 'Sermon / Teaching', presetId: 'preset-preaching', obsScene: 'Sanctuary Wide + Preacher' },
  { id: 'cue-5', order: '05', name: 'Altar Call & Prayer', presetId: 'preset-prayer', obsScene: 'Pulpit Close-Up' },
];

export const PresetsServiceModule: React.FC<PresetsServiceModuleProps> = ({
  device,
  dsp,
  obsStatus,
  onUpdateObs,
  presets,
  activePreset,
  onSelectPreset,
  versions,
  onSaveVersion,
  onRollbackVersion,
  onImportPresetJson,
}) => {
  const [snapshotNote, setSnapshotNote] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [comparePresetId, setComparePresetId] = useState<string>(presets[0]?.id ?? '');
  const [activeCueId, setActiveCueId] = useState<string | null>(null);

  const comparePreset = presets.find((p) => p.id === comparePresetId) ?? activePreset;

  const handleSaveSnapshot = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveVersion(snapshotNote.trim() || `Console snapshot from ${activePreset.name}`);
    setSnapshotNote('');
  };

  const handleExportConfig = () => {
    const payload = JSON.stringify(activePreset, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activePreset.id}-v${activePreset.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result ?? '')) as ServicePreset;
        if (!parsed.dsp || !parsed.name) {
          setImportError('INVALID PRESET JSON');
          return;
        }
        onImportPresetJson({ ...parsed, id: `imported-${Date.now()}` });
      } catch {
        setImportError('JSON PARSE FAIL');
      }
    };
    reader.readAsText(file);
  };

  const handleFireServiceCue = (cue: (typeof SERVICE_ORDER_CUES)[number]) => {
    setActiveCueId(cue.id);
    const found = presets.find((p) => p.id === cue.presetId) ?? presets[0];
    if (found) onSelectPreset(found);
    onUpdateObs({ activeScene: cue.obsScene });
  };

  return (
    <div className="space-y-4">
      {/* Studio Header */}
      <div className="rounded-lg border border-slate-800 bg-gradient-to-b from-[#161D29] to-[#0E131C] p-3.5 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-8 rounded-xs bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.6)]" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-bold text-sky-400">10</span>
              <h1 className="font-display text-lg font-semibold text-white tracking-tight">
                PRESETS, SERVICE PROFILES &amp; SNAPSHOT VAULT
              </h1>
            </div>
            <p
              className="text-[9.5px] font-mono font-bold uppercase hw-engraved"
              title={`Active profile: ${activePreset.name} (v${activePreset.version}) · ${device.model} · OBS ${obsStatus.activeScene}`}
            >
              ACTIVE {activePreset.name} · V{activePreset.version} · {device.model} · OBS {obsStatus.activeScene}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label
            className="px-2.5 py-1.5 rounded hw-key hover:!border-sky-500/50 text-[11px] font-mono font-semibold flex items-center gap-1.5 cursor-pointer"
            title="Import a console preset JSON export"
          >
            <Upload className="w-3.5 h-3.5 text-sky-400" />
            <span>IMPORT JSON</span>
            <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
          </label>
          <button
            type="button"
            onClick={handleExportConfig}
            className="px-2.5 py-1.5 rounded hw-key hover:!border-sky-500/50 text-[11px] font-mono font-semibold flex items-center gap-1.5 cursor-pointer"
            title="Export the active preset as a JSON file"
          >
            <Download className="w-3.5 h-3.5 text-sky-400" />
            <span>EXPORT ACTIVE</span>
          </button>
        </div>
      </div>

      {importError && (
        <div className="p-3 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300" title="Import failed — select a valid Church Audio preset JSON export">
          {importError}
        </div>
      )}

      {/* Service Order Cue Sequencer */}
      <div className="rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-2.5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
          <span
            className="font-mono text-xs font-semibold uppercase flex items-center gap-1.5 hw-engraved"
            title="Sunday service cue sequencer — DSP + OBS linked recall"
          >
            <Layers className="w-3.5 h-3.5 text-sky-400" />
            <span>Service Cue Sequencer · DSP + OBS</span>
          </span>
            <span
              className="font-mono text-[10px] text-slate-400"
              title="Click a cue to recall its DSP state + OBS stream scene together"
            >
              CUE FIRE = DSP + OBS
            </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          {SERVICE_ORDER_CUES.map((cue) => {
            const active = activeCueId === cue.id;
            return (
              <button
                key={cue.id}
                type="button"
                onClick={() => handleFireServiceCue(cue)}
                className={`p-2.5 rounded text-left transition-colors hw-key ${
                  active
                    ? '!bg-none !border-sky-400 !bg-sky-500/15'
                    : 'hover:!border-slate-500'
                }`}
              >
                <div className="flex items-center justify-between font-mono text-[10px] text-sky-400">
                  <span>CUE {cue.order}</span>
                  <span>{active ? 'LIVE' : 'STANDBY'}</span>
                </div>
                <div className="text-xs font-semibold text-white mt-1 truncate">{cue.name}</div>
                <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5">
                  OBS: {cue.obsScene}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Grid: Scene Memory Table | Diff & Versioned Snapshot Vault */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 items-stretch">
        {/* Scene Memory Table (Clean Console Rows — Zero Stuffy Cards) */}
        <div className="xl:col-span-7 rounded-lg border border-slate-800 bg-[#0A0E17] p-3 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <span className="font-mono text-xs font-bold uppercase tracking-wider hw-engraved">
              Scene Memory Bank ({presets.length} Profiles)
            </span>
            <span
              className="font-mono text-[10px] text-sky-400"
              title="Click a row to inspect · LOAD recalls its DSP + OBS curve"
            >
              ROW = INSPECT · LOAD = RECALL
            </span>
          </div>

          <div className="divide-y divide-slate-800/70 rounded-lg border border-slate-800 bg-[#060910] overflow-hidden">
            {presets.map((p, idx) => {
              const active = p.id === activePreset.id;
              const comparing = p.id === comparePreset.id;
              return (
                <div
                  key={p.id}
                  onClick={() => setComparePresetId(p.id)}
                  className={`px-3 py-2 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                    active
                      ? 'bg-sky-500/15 border-l-2 border-l-sky-400'
                      : comparing
                        ? 'bg-amber-500/10 border-l-2 border-l-amber-400'
                        : 'hover:bg-slate-900/70 border-l-2 border-l-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span
                      className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold shrink-0 ${
                        active
                          ? 'bg-sky-500 text-slate-950'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      SCN {String(idx + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-white truncate">{p.name}</span>
                        <span className="text-[10px] font-mono text-slate-500 hidden sm:inline">
                          {p.category}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0 font-mono text-[10px]">
                    <span className="text-sky-300/90 tabular-nums hidden md:inline">
                      HPF {p.dsp.hpfHz}Hz · {p.dsp.compressor.ratio}:1 · {p.broadcastDsp.targetLufs} LUFS
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setComparePresetId(p.id);
                      }}
                      className={`px-2 py-1 rounded border text-[10px] cursor-pointer ${
                        comparing
                          ? 'border-amber-400/60 bg-amber-500/20 text-amber-200 font-bold'
                          : 'border-slate-700 bg-[#111723] text-slate-400 hover:text-white'
                      }`}
                    >
                      DIFF
                    </button>
                    <ConsolePushButton
                      label={active ? 'ACTIVE' : 'LOAD'}
                      active={active}
                      tone="sky"
                      onClick={() => onSelectPreset(p)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected Scene Summary Bar — console scribble strip: name + version,
              full description rides on the tooltip */}
          <div className="px-3 py-2 rounded border border-slate-800 bg-[#060910] font-mono text-[11px] flex items-center justify-between gap-2">
            <span
              className="text-slate-300 truncate"
              title={`${comparePreset.name}: ${comparePreset.description}`}
            >
              <strong className="text-sky-300">{comparePreset.name}</strong>
            </span>
            <span className="text-slate-400 shrink-0 hw-lcd rounded px-1.5 py-0.5">v{comparePreset.version}</span>
          </div>
        </div>

        {/* Preset Parameter Diff + Versioned Snapshot Vault */}
        <div className="xl:col-span-5 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 flex flex-col justify-between gap-3">
          {/* Parameter Diff Preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-mono text-xs font-semibold uppercase hw-engraved">
                Parameter Diff Inspector
              </span>
              <span className="font-mono text-[10px] text-amber-400 truncate max-w-[180px]">
                Live vs {comparePreset.name}
              </span>
            </div>

            {/* Diff readout — live vs selected scene, LED per parameter
                (amber = will change on recall, green = identical) */}
            <div className="rounded border border-slate-800 bg-[#070A10] p-2.5 text-[11px] font-mono space-y-1.5 tabular-nums">
              {([
                {
                  label: 'HPF CUTOFF',
                  live: `${dsp.hpfHz} Hz`,
                  target: `${comparePreset.dsp.hpfHz} Hz`,
                  delta: dsp.hpfHz !== comparePreset.dsp.hpfHz,
                },
                {
                  label: 'COMP THR',
                  live: `${dsp.compressor.thresholdDb} dB`,
                  target: `${comparePreset.dsp.compressor.thresholdDb} dB`,
                  delta: dsp.compressor.thresholdDb !== comparePreset.dsp.compressor.thresholdDb,
                },
                {
                  label: 'COMP RATIO',
                  live: `${dsp.compressor.ratio}:1`,
                  target: `${comparePreset.dsp.compressor.ratio}:1`,
                  delta: dsp.compressor.ratio !== comparePreset.dsp.compressor.ratio,
                },
                {
                  label: 'LIMITER CEIL',
                  live: `${dsp.limiter.ceilingDb} dBFS`,
                  target: `${comparePreset.dsp.limiter.ceilingDb} dBFS`,
                  delta: dsp.limiter.ceilingDb !== comparePreset.dsp.limiter.ceilingDb,
                },
                {
                  label: 'STREAM TGT',
                  live: `${comparePreset.broadcastDsp.targetLufs} LUFS`,
                  target: `${comparePreset.broadcastDsp.targetLufs} LUFS`,
                  delta: false,
                },
              ] as const).map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      aria-hidden="true"
                      className="hw-lamp shrink-0"
                      style={{ width: 5, height: 5 }}
                      data-on={row.delta ? 'amber' : 'green'}
                    />
                    <span className="text-slate-400">{row.label}</span>
                  </span>
                  <span className="shrink-0">
                    <span className="text-slate-300">{row.live}</span>
                    <span className="text-slate-600 mx-1">→</span>
                    <span className="text-sky-400">{row.target}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Snapshot Save & Rollback */}
          <div className="space-y-2.5 border-t border-slate-800 pt-3 flex-1 flex flex-col">
            <div className="font-mono text-xs font-semibold uppercase hw-engraved">
              Versioned Configuration Vault
            </div>

            <form onSubmit={handleSaveSnapshot} className="flex gap-2">
              <input
                type="text"
                value={snapshotNote}
                onChange={(e) => setSnapshotNote(e.target.value)}
                placeholder="SNAPSHOT NOTE"
                aria-label="Snapshot note (e.g. Sunday Sermon Trim)"
                className="flex-1 px-2.5 py-1.5 rounded border border-slate-700 bg-[#070A10] text-xs font-mono text-slate-100"
              />
              <button
                type="submit"
                title="Store a versioned configuration snapshot in the vault"
                className="px-3 py-1.5 rounded hw-key !bg-none !bg-sky-600 hover:!bg-sky-500 !border-sky-400/60 !text-white text-xs font-mono font-semibold flex items-center gap-1 shrink-0 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>STORE</span>
              </button>
            </form>

            <div className="divide-y divide-slate-800/80 max-h-56 overflow-y-auto bg-[#090D14] rounded border border-slate-800 px-3 flex-1">
              {versions.length === 0 ? (
                <div className="py-6 flex flex-col items-center justify-center gap-2 text-center">
                  <span aria-hidden="true" className="hw-lamp" style={{ width: 6, height: 6 }} />
                  <span
                    className="font-mono text-[10px] font-bold tracking-wider text-slate-500"
                    title="Save a baseline snapshot before live service edits — snapshots become your rollback points"
                  >
                    NO SNAPSHOTS — STORE A BASELINE
                  </span>
                </div>
              ) : (
                versions.map((v) => (
                  <div key={v.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <div className="text-xs font-semibold text-white truncate">
                        {v.presetName} · <span className="font-mono text-sky-400">{v.version}</span>
                      </div>
                      <div className="text-[11px] text-slate-400 truncate">{v.summary}</div>
                      <div className="font-mono text-[10px] text-slate-500">
                        {new Date(v.timestamp).toLocaleTimeString()} · {v.platform.toUpperCase()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRollbackVersion(v)}
                      className="px-2.5 py-1 rounded hw-key hover:!border-sky-500/60 text-[11px] font-mono font-semibold flex items-center gap-1 shrink-0 cursor-pointer"
                      title={`Roll back to ${v.presetName} ${v.version}`}
                    >
                      <RotateCcw className="w-3 h-3 text-sky-400" />
                      <span>RECALL</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
