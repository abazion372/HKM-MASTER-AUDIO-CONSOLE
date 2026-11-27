import React, { useEffect, useMemo, useState } from 'react';
import { Zap, ShieldAlert, ArrowRight, RotateCcw } from 'lucide-react';
import type {
  AudioSourceSimulation,
  ChannelInputMode,
  DspConfig,
  InputChannel,
  ServicePreset,
  SignalTelemetry,
  SpeakerZone,
  HardwareDevice,
} from '../types/audio.ts';
import { ConsolePushButton, RotaryKnob } from './StudioControls.tsx';
import { StereoGraphicEqModule } from './StereoGraphicEqModule.tsx';
import { ActiveCrossoverModule } from './ActiveCrossoverModule.tsx';
import {
  INSTRUMENT_RIG_CHECKLIST,
  INPUT_MODES,
  INPUT_MODE_ORDER,
  clampGainForMode,
  getInputMode,
} from '../utils/inputMode.ts';

export type ConsoleProcessingPhase =
  | 'phase-1-stage'
  | 'phase-2-filters'
  | 'phase-3-peq'
  | 'phase-4-dynamics'
  | 'phase-5-geq'
  | 'phase-6-xover'
  | 'phase-7-matrix';

interface ConsoleInstrumentDeckProps {
  device: HardwareDevice;
  channels: InputChannel[];
  onUpdateChannel: (id: string, patch: Partial<InputChannel>) => void;
  dsp: DspConfig;
  onUpdateDsp: (patch: Partial<DspConfig>) => void;
  telemetry: SignalTelemetry;
  presets: ServicePreset[];
  activePreset?: ServicePreset;
  onSelectPreset?: (preset: ServicePreset) => void;
  emergencyMuted?: boolean;
  onToggleEmergencyMute?: () => void;
  zones?: SpeakerZone[];
  initialPhase?: ConsoleProcessingPhase;
  selectedChannelId?: string;
  locked?: boolean;
  audioSource?: AudioSourceSimulation;
  onAddEqBand?: () => void;
  onRemoveEqBand?: (bandId: string) => void;
  inputDevices?: MediaDeviceInfo[];
  outputDevices?: MediaDeviceInfo[];
  preferredOutputDeviceId?: string;
  preferredStreamOutputDeviceId?: string;
  onSelectOutputDevice?: (deviceId: string) => void;
  onSelectStreamOutputDevice?: (deviceId: string) => void;
  onUpdateZone?: (id: string, patch: Partial<SpeakerZone>) => void;
  onScanAudioDevices?: (requestPermission?: boolean) => Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>;
}

const PEQ_BAND_STYLES = [
  {
    name: 'BAND 1 · LOW',
    accent: 'red' as const,
    card: 'border-rose-500/40 bg-gradient-to-b from-[#1A0D12] to-[#0D070A]',
    badge: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
    dot: '#FB7185',
    minHz: 30,
    maxHz: 350,
  },
  {
    name: 'BAND 2 · LO-MID',
    accent: 'amber' as const,
    card: 'border-amber-500/40 bg-gradient-to-b from-[#191208] to-[#0D0904]',
    badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    dot: '#FBBF24',
    minHz: 120,
    maxHz: 1500,
  },
  {
    name: 'BAND 3 · HI-MID',
    accent: 'emerald' as const,
    card: 'border-emerald-500/40 bg-gradient-to-b from-[#091812] to-[#050D0A]',
    badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    dot: '#34D399',
    minHz: 800,
    maxHz: 6000,
  },
  {
    name: 'BAND 4 · HIGH',
    accent: 'sky' as const,
    card: 'border-sky-500/40 bg-gradient-to-b from-[#0A1522] to-[#050A11]',
    badge: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
    dot: '#38BDF8',
    minHz: 3500,
    maxHz: 18000,
  },
];

/* Silkscreen check keys for the instrument-rig LED chips — full notes live in tooltips */
const INSTRUMENT_RIG_KEYS = ['HI-Z JACK', '48V LOCK', 'GAIN SET'];

export const ConsoleInstrumentDeck: React.FC<ConsoleInstrumentDeckProps> = ({
  channels,
  onUpdateChannel,
  dsp,
  onUpdateDsp,
  telemetry,
  presets,
  activePreset,
  onSelectPreset,
  emergencyMuted = false,
  onToggleEmergencyMute,
  zones = [],
  initialPhase,
  selectedChannelId: controlledChannelId,
  locked = false,
  audioSource,
  onAddEqBand,
}) => {
  const [selectedPhase, setSelectedPhase] = useState<ConsoleProcessingPhase>(initialPhase ?? 'phase-3-peq');

  useEffect(() => {
    if (initialPhase) {
      setSelectedPhase(initialPhase);
    }
  }, [initialPhase]);

  const [localChannelId] = useState<string>(channels[0]?.id ?? 'ch-1');
  const activeChannelId = controlledChannelId ?? localChannelId;
  const [peqPageOffset, setPeqPageOffset] = useState<number>(0);

  const selectedChannel: InputChannel =
    channels.find((c) => c.id === activeChannelId) ??
    channels[0] ?? {
      id: 'ch-1',
      index: 1,
      name: 'Channel 1',
      role: 'Vocals',
      authority: 'local',
      levelDb: -24,
      peakDb: -18,
      gainDb: 24,
      faderDb: 0,
      mute: false,
      solo: false,
      phantom48v: false,
      padDb: false,
      polarityInverted: false,
      hpfHz: 80,
      pan: 0,
      noiseFloorDb: -58,
      gateThresholdDb: -42,
      compThresholdDb: -18,
      compRatio: 3,
      eqLowDb: 0,
      eqMidDb: 0,
      eqMidFreqHz: 2500,
      eqHighDb: 0,
      auxSends: { stageMon1Db: -6, stageMon2Db: -6, streamBusDb: 0, subsDb: -6 },
      dcaGroup: 'All',
      stereoLinked: false,
    };

  const isBridgeSlot = (ch: InputChannel) =>
    ch.index === 1 && (audioSource === 'desktop-audio' || audioSource === 'pink-noise');
  const selectedAssigned = Boolean(selectedChannel.hardwareInputId) || isBridgeSlot(selectedChannel);

  // Real-world input source mode of the focused strip (MIC / LINE / INST)
  const selMode = getInputMode(selectedChannel);
  const selModeSpec = INPUT_MODES[selMode];
  const switchSelectedInputMode = (next: ChannelInputMode) => {
    const patch: Partial<InputChannel> = { inputMode: next };
    if (next !== 'mic' && selectedChannel.phantom48v) patch.phantom48v = false;
    patch.gainDb = clampGainForMode(selectedChannel.gainDb, next);
    onUpdateChannel(selectedChannel.id, patch);
  };

  // Real-time PEQ Curve Geometry for Phase 3
  const peqGeometry = useMemo(() => {
    const width = 640;
    const height = 130;
    const minF = 20;
    const maxF = 20000;
    const points: string[] = [];

    const freqToX = (f: number) => {
      const minLog = Math.log10(minF);
      const maxLog = Math.log10(maxF);
      const fLog = Math.log10(Math.max(minF, Math.min(maxF, f)));
      return ((fLog - minLog) / (maxLog - minLog)) * width;
    };

    const gainToY = (db: number) => {
      const clampedDb = Math.max(-18, Math.min(18, db));
      return height * 0.5 - (clampedDb / 18) * (height * 0.4);
    };

    const numPoints = 84;
    for (let i = 0; i <= numPoints; i++) {
      const freq = minF * Math.pow(maxF / minF, i / numPoints);
      const x = freqToX(freq);

      let gainDb = 0;
      if (!dsp.bypassed) {
        for (const band of dsp.eqBands) {
          if (!band.enabled) continue;
          const f0 = band.frequency;
          const q = Math.max(0.2, band.q);
          const g = band.gainDb;
          const octDiff = Math.abs(Math.log2(freq / f0));
          const bandFactor = Math.exp(-Math.pow(octDiff * q, 2) * 2.2);
          gainDb += g * bandFactor;
        }
        if (dsp.hpfEnabled && freq < dsp.hpfHz) {
          const ratio = dsp.hpfHz / freq;
          gainDb -= 12 * Math.log2(Math.max(1, ratio));
        }
      }

      points.push(`${x.toFixed(1)},${gainToY(gainDb).toFixed(1)}`);
    }

    const path = `M ${points.join(' L ')}`;
    const area = `${path} L ${width},${height * 0.5} L 0,${height * 0.5} Z`;
    const nodes = dsp.eqBands.slice(0, 4).map((b, idx) => ({
      id: b.id,
      x: freqToX(b.frequency),
      y: gainToY(b.enabled ? b.gainDb : 0),
      enabled: b.enabled,
      color: PEQ_BAND_STYLES[idx]?.dot ?? '#38BDF8',
    }));

    return { path, area, nodes, midY: height * 0.5 };
  }, [dsp.bypassed, dsp.eqBands, dsp.hpfEnabled, dsp.hpfHz]);

  const phaseTabs: {
    id: ConsoleProcessingPhase;
    step: string;
    label: string;
    fullTitle: string;
    readout: string;
    activeClass: string;
    ledClass: string;
    topBarClass: string;
    enabled: boolean;
  }[] = [
    {
      id: 'phase-1-stage',
      step: '1',
      label: 'PREAMP',
      fullTitle: 'Phase 1 · Stage Preamp & Ground Hum Traps',
      readout: selectedAssigned ? `+${selectedChannel.gainDb}dB` : 'OPEN',
      activeClass: 'bg-amber-500/25 border-2 border-amber-400 text-amber-200 shadow-[0_0_12px_rgba(251,191,36,0.5)] font-extrabold',
      ledClass: selectedAssigned ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]' : 'bg-slate-600',
      topBarClass: 'bg-amber-400',
      enabled: selectedAssigned,
    },
    {
      id: 'phase-2-filters',
      step: '2',
      label: 'HPF & GATE',
      fullTitle: 'Phase 2 · Bandpass Filters & Noise Gate',
      readout: dsp.hpfEnabled ? `${dsp.hpfHz}Hz` : 'BYP',
      activeClass: 'bg-cyan-500/25 border-2 border-cyan-400 text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.5)] font-extrabold',
      ledClass: dsp.hpfEnabled ? 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]' : 'bg-slate-600',
      topBarClass: 'bg-cyan-400',
      enabled: dsp.hpfEnabled,
    },
    {
      id: 'phase-3-peq',
      step: '3',
      label: '4-BAND PEQ',
      fullTitle: 'Phase 3 · 4-Band Parametric EQ & Live RTA',
      readout: 'RTA LIVE',
      activeClass: 'bg-sky-500/25 border-2 border-sky-400 text-sky-200 shadow-[0_0_12px_rgba(56,189,248,0.5)] font-extrabold',
      ledClass: 'bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.8)]',
      topBarClass: 'bg-sky-400',
      enabled: true,
    },
    {
      id: 'phase-4-dynamics',
      step: '4',
      label: 'VCA COMP',
      fullTitle: 'Phase 4 · VCA Dynamics Compressor & De-Esser',
      readout: dsp.compressor.enabled ? `${dsp.compressor.ratio.toFixed(1)}:1` : 'OFF',
      activeClass: 'bg-emerald-500/25 border-2 border-emerald-400 text-emerald-200 shadow-[0_0_12px_rgba(52,211,153,0.5)] font-extrabold',
      ledClass: dsp.compressor.enabled ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]' : 'bg-slate-600',
      topBarClass: 'bg-emerald-400',
      enabled: dsp.compressor.enabled,
    },
    {
      id: 'phase-5-geq',
      step: '5',
      label: '31-BAND GEQ',
      fullTitle: 'Phase 5 · Pro Stereo 31-Band Graphic EQ',
      readout: `±${dsp.graphicEq31?.rangeDb ?? 12}dB`,
      activeClass: 'bg-fuchsia-500/25 border-2 border-fuchsia-400 text-fuchsia-200 shadow-[0_0_12px_rgba(232,121,249,0.5)] font-extrabold',
      ledClass: dsp.graphicEq31?.enabled !== false ? 'bg-fuchsia-400 shadow-[0_0_6px_rgba(232,121,249,0.8)]' : 'bg-slate-600',
      topBarClass: 'bg-fuchsia-400',
      enabled: dsp.graphicEq31?.enabled !== false,
    },
    {
      id: 'phase-6-xover',
      step: '6',
      label: '3-WAY XOVER',
      fullTitle: 'Phase 6 · Active 3-Way Linkwitz-Riley Crossover',
      readout: `${dsp.crossover?.subToMidHz ?? 80}Hz`,
      activeClass: 'bg-violet-500/25 border-2 border-violet-400 text-violet-200 shadow-[0_0_12px_rgba(167,139,250,0.5)] font-extrabold',
      ledClass: dsp.crossover?.enabled !== false ? 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.8)]' : 'bg-slate-600',
      topBarClass: 'bg-violet-400',
      enabled: dsp.crossover?.enabled !== false,
    },
    {
      id: 'phase-7-matrix',
      step: '7',
      label: 'MATRIX & PA',
      fullTitle: 'Phase 7 · Output Bus Matrix & Speaker Peak Limiter',
      readout: dsp.limiter.enabled ? `${dsp.limiter.ceilingDb.toFixed(1)}dB` : 'OPEN',
      activeClass: 'bg-orange-500/25 border-2 border-orange-400 text-orange-200 shadow-[0_0_12px_rgba(251,146,60,0.5)] font-extrabold',
      ledClass: dsp.limiter.enabled ? 'bg-orange-400' : 'bg-slate-600',
      topBarClass: 'bg-orange-400',
      enabled: dsp.limiter.enabled,
    },
  ];

  const meterPct = Math.max(0, Math.min(100, ((telemetry.postRmsDb + 60) / 60) * 100));
  const grSegments = 12;
  const activeGrCount = Math.min(grSegments, Math.round((Math.abs(telemetry.gainReductionDb) / 18) * grSegments));

  return (
    <div className="h-full w-full overflow-hidden flex flex-col bg-[#080B12] text-slate-100 font-sans select-none border border-slate-700/80 rounded-lg shadow-2xl">
      {/* =========================================================================
          TOP DECK ROW 1: MASTER CONSOLE STATUS, METER BRIDGE & SCENE RECALL
          ========================================================================= */}
      <div className="h-8 shrink-0 bg-gradient-to-b from-[#141B28] to-[#0D121C] border-b border-slate-700/70 px-3 flex items-center justify-between gap-3">
        {/* Left: Console Identity & Hardware Lock */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className="hw-lamp shrink-0"
            data-on={telemetry?.isRunning ? 'green' : undefined}
            style={{ width: 6, height: 6 }}
            aria-hidden="true"
          />
          <div className="flex items-center gap-2 min-w-0 font-mono">
            <span className="text-[11px] font-bold text-emerald-400 tracking-wider whitespace-nowrap">
              HKM CONSOLE INSTRUMENT
            </span>
            <span className="text-slate-600 hidden md:inline">|</span>
            <span
              className="text-[10px] text-slate-400 truncate hidden md:inline"
              title={
                telemetry?.isRunning
                  ? `LIVE AUDIO ENGINE · ${(telemetry.sampleRate / 1000).toFixed(1)} kHz · ACTIVE`
                  : 'LIVE AUDIO ENGINE · READY'
              }
            >
              {telemetry?.isRunning
                ? `ENGINE LIVE · ${(telemetry.sampleRate / 1000).toFixed(1)} kHz`
                : 'ENGINE READY'}
            </span>
          </div>
        </div>

        {/* Center: Master Output Stereo VU Meter */}
        <div className="hidden sm:flex items-center gap-2 bg-[#05070C] px-2.5 py-1 rounded border border-slate-700/80 font-mono text-[9px] shrink-0">
          <span className="text-slate-400 font-semibold">MAIN L/R</span>
          <div className="flex flex-col gap-0.5 w-20">
            <div className="hw-led-track-h h-[9px] w-full">
              {Array.from({ length: 12 }).map((_, seg) => {
                const lit = meterPct >= ((seg + 1) / 12) * 100;
                return (
                  <span
                    key={seg}
                    className="hw-led-seg"
                    data-lit={
                      lit
                        ? seg >= 11
                          ? 'red'
                          : seg >= 9 || telemetry.postPeakDb > -3
                            ? 'amber'
                            : 'green'
                        : undefined
                    }
                  />
                );
              })}
            </div>
            <div className="hw-led-track-h h-[9px] w-full">
              {Array.from({ length: 12 }).map((_, seg) => {
                const lit = Math.max(0, meterPct - 2) >= ((seg + 1) / 12) * 100;
                return (
                  <span
                    key={seg}
                    className="hw-led-seg"
                    data-lit={
                      lit
                        ? seg >= 11
                          ? 'red'
                          : seg >= 9 || telemetry.postPeakDb > -3
                            ? 'amber'
                            : 'green'
                        : undefined
                    }
                  />
                );
              })}
            </div>
          </div>
          <span
            className={`hw-lcd rounded px-1.5 font-bold tabular-nums w-14 text-right ${
              telemetry.postPeakDb > -3 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {telemetry.isRunning ? `${telemetry.postPeakDb.toFixed(1)} dB` : 'STANDBY'}
          </span>
        </div>

        {/* Right: Scene Recall, DSP Master Switch, Safe Mute */}
        <div className="flex items-center gap-1.5 shrink-0">
          {presets.length > 0 && (
            <select
              value={activePreset?.id ?? ''}
              onChange={(e) => {
                const found = presets.find((p) => p.id === e.target.value);
                if (found && onSelectPreset) onSelectPreset(found);
              }}
              className="bg-[#060910] border border-slate-700 text-slate-200 text-[10px] font-mono px-2 py-1 rounded cursor-pointer max-w-[175px]"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          <ConsolePushButton
            label={dsp.bypassed ? 'BYPASSED' : 'DSP ON'}
            active={!dsp.bypassed}
            tone={dsp.bypassed ? 'amber' : 'emerald'}
            onClick={() => onUpdateDsp({ bypassed: !dsp.bypassed })}
          />

          {onToggleEmergencyMute && (
            <ConsolePushButton
              label={emergencyMuted ? 'MUTED' : 'SAFE MUTE'}
              active={emergencyMuted}
              tone="red"
              onClick={onToggleEmergencyMute}
            />
          )}
        </div>
      </div>

      {/* =========================================================================
          TOP DECK ROW 2: SIGNAL-FLOW PHASE TABS — FULLY LABELED, DISTANCE-READABLE
          Two-line hardware strip: full processor name (never truncated) on top,
          live value readout below. Row scrolls horizontally on narrow screens
          instead of clipping labels.
          ========================================================================= */}
      <div className="shrink-0 bg-[#070B13] border-b border-slate-700/80 px-2.5 py-1 flex items-stretch gap-1 overflow-x-auto scrollbar-none">
        {phaseTabs.map((tab, idx) => {
          const active = selectedPhase === tab.id;
          return (
            <React.Fragment key={tab.id}>
              <button
                type="button"
                onClick={() => setSelectedPhase(tab.id)}
                title={`${tab.fullTitle}${tab.readout ? ` · ${tab.readout}` : ''}`}
                aria-current={active ? 'true' : undefined}
                className={`relative rounded-md border-2 px-2.5 py-1 flex-1 min-w-[128px] flex flex-col items-start justify-center gap-0.5 font-mono transition-all cursor-pointer overflow-hidden shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/70 ${
                  active
                    ? tab.activeClass
                    : 'bg-[#0E1422] border-slate-700/90 text-slate-300 hover:bg-[#151D30] hover:text-white hover:border-slate-500 shadow-sm'
                }`}
              >
                {/* Top Illuminated Hardware Accent Bar */}
                {active && (
                  <span className={`absolute inset-x-0 top-0 h-[3px] ${tab.topBarClass}`} />
                )}
                {/* Line 1: LED + phase number + full label (never truncated) */}
                <div className="relative z-10 flex items-center gap-1.5 w-full min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${tab.ledClass}`} />
                  <span
                    className={`text-[11px] font-extrabold shrink-0 tabular-nums ${
                      active ? 'text-white' : 'text-slate-400'
                    }`}
                  >
                    {tab.step}.
                  </span>
                  <span className="text-[11px] font-extrabold tracking-wide whitespace-nowrap">
                    {tab.label}
                  </span>
                </div>
                {/* Line 2: live value readout, always visible */}
                <div className="relative z-10 flex items-center w-full pl-[14px]">
                  <span
                    className={`text-[10px] font-bold tabular-nums tracking-wide whitespace-nowrap ${
                      active ? 'text-white opacity-100' : 'text-slate-400 opacity-80'
                    }`}
                  >
                    {tab.readout}
                  </span>
                </div>
              </button>
              {idx < phaseTabs.length - 1 && (
                <ArrowRight
                  className={`w-3.5 h-3.5 self-center shrink-0 hidden lg:block ${
                    active ? 'text-white/80' : 'text-slate-500'
                  }`}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* =========================================================================
          MIDDLE DECK: FOCUSED HARDWARE PROCESSING RACK (ZERO SCROLL)
          ========================================================================= */}
      <div className={`flex-1 min-h-0 overflow-hidden flex flex-row ${locked ? 'opacity-90' : ''}`}>
        {/* Focused Hardware Processing Deck */}
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden p-1.5 bg-[#0A0E13] flex flex-col">
        {/* PHASE 1: STAGE PREAMP & GROUND HUM TRAPS */}
        {selectedPhase === 'phase-1-stage' && (
          <div className="h-full min-h-0 flex flex-col justify-between p-3 rounded-lg border border-amber-500/40 bg-gradient-to-b from-[#16110A] via-[#0D0B07] to-[#080705] shadow-inner">
            <div className="flex items-center justify-between border-b border-amber-500/25 pb-1.5 shrink-0">
              <div className="flex items-center gap-2">
                <span
                  className={`hw-lamp shrink-0 ${selectedAssigned ? '' : 'opacity-60'}`}
                  data-on={selectedAssigned ? 'amber' : undefined}
                  style={{ width: 6, height: 6 }}
                  aria-hidden="true"
                />
                <h3 className="font-mono text-xs font-bold text-amber-100 tracking-wider uppercase">
                  PHASE 1 · STAGE PREAMP &amp; GROUND HUM TRAPS — {selectedAssigned ? selectedChannel.name : `CH${selectedChannel.index} OPEN`}
                </h3>
              </div>
              <span
                className={`font-mono text-[11px] font-semibold ${
                  selectedAssigned ? 'text-amber-400' : 'text-slate-400'
                }`}
                title={
                  selectedAssigned
                    ? `Input: ${selectedChannel.hardwareInputLabel || selectedChannel.name}`
                    : 'Open Slot — No Input Assigned'
                }
              >
                {selectedAssigned
                  ? `IN · ${selectedChannel.hardwareInputLabel || selectedChannel.name}`
                  : 'OPEN · NO INPUT'}
              </span>
              <span
                className={`font-mono text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${
                  selMode === 'inst'
                    ? 'bg-fuchsia-500/20 border-fuchsia-400/60 text-fuchsia-300'
                    : selMode === 'line'
                      ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300'
                      : 'bg-cyan-500/20 border-cyan-400/60 text-cyan-300'
                }`}
                title={`${selModeSpec.fullLabel} — ${selModeSpec.domainNote}`}
              >
                {selMode === 'inst' ? 'INST · Hi-Z 1MΩ' : selMode === 'line' ? 'LINE · ±12 dB' : 'MIC · 48V READY'}
              </span>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-3 gap-3 py-2 items-center">
              {/* Group A: Analog Gain & Trim */}
              <div className="h-full rounded-lg border border-amber-500/25 bg-[#0C0906] p-3 flex items-center justify-around">
                <RotaryKnob
                  label={selMode === 'line' ? 'Line Trim' : 'Preamp Gain'}
                  value={
                    selectedAssigned ? clampGainForMode(selectedChannel.gainDb, selMode) : selModeSpec.unityGainDb
                  }
                  min={selModeSpec.gainMin}
                  max={selModeSpec.gainMax}
                  step={1}
                  defaultValue={selModeSpec.unityGainDb}
                  unit="dB"
                  size={64}
                  accent={selectedAssigned ? 'amber' : 'slate'}
                  disabled={locked || !selectedAssigned}
                  formatValue={
                    !selectedAssigned ? () => '--' : (v) => selModeSpec.formatGain(v)
                  }
                  onChange={(v) => onUpdateChannel(selectedChannel.id, { gainDb: v })}
                />
                <RotaryKnob
                  label="Master Trim"
                  value={dsp.inputTrimDb}
                  min={-18}
                  max={18}
                  step={0.5}
                  defaultValue={0}
                  unit="dB"
                  size={64}
                  accent="amber"
                  disabled={locked}
                  onChange={(v) => onUpdateDsp({ inputTrimDb: v })}
                />
              </div>

              {/* Group B: Input Mode Selector + Phantom, Pad & Polarity Switches */}
              <div className="h-full rounded-lg border border-slate-700/70 bg-[#0D1017] p-3 flex flex-col justify-center gap-2 font-mono text-xs">
                <span className="hw-engraved text-[10px] uppercase font-bold tracking-wider">
                  Input Stage &amp; Conditioning
                </span>
                <div
                  className="grid grid-cols-3 gap-1"
                  role="radiogroup"
                  aria-label="Channel input source mode"
                >
                  {INPUT_MODE_ORDER.map((m) => {
                    const active = selMode === m;
                    const spec = INPUT_MODES[m];
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={locked}
                        onClick={() => switchSelectedInputMode(m)}
                        title={`${spec.fullLabel} — ${spec.domainNote}`}
                        className={`py-1.5 rounded font-bold text-[10px] border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hw-key ${
                          active
                            ? m === 'mic'
                              ? '!bg-none !border-cyan-300 !bg-cyan-500 !text-slate-950 shadow-[0_0_10px_rgba(34,211,238,0.45)]'
                              : m === 'line'
                                ? '!bg-none !border-emerald-300 !bg-emerald-500 !text-slate-950 shadow-[0_0_10px_rgba(16,185,129,0.45)]'
                                : '!bg-none !border-fuchsia-300 !bg-fuchsia-500 !text-slate-950 shadow-[0_0_10px_rgba(217,70,239,0.5)]'
                            : ''
                        }`}
                      >
                        {spec.shortLabel}
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={locked || !selectedAssigned || !selModeSpec.phantomAllowed}
                    onClick={() =>
                      onUpdateChannel(selectedChannel.id, {
                        phantom48v: !selectedChannel.phantom48v,
                      })
                    }
                    title={
                      !selModeSpec.phantomAllowed
                        ? selMode === 'inst'
                          ? '+48V LOCKED — phantom power into an instrument or unprotected DI can destroy it (auto-disengaged)'
                          : '+48V unavailable on LINE jacks (mic domain only)'
                        : '+48V Phantom Power for condenser microphones'
                    }
                    className={`py-2 rounded font-bold border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1 text-[11px] hw-key ${
                      selectedAssigned && selectedChannel.phantom48v && selModeSpec.phantomAllowed
                        ? '!bg-none !border-red-400 !bg-red-600 !text-white shadow-[0_0_12px_rgba(239,68,68,0.7)]'
                        : ''
                    }`}
                  >
                    <Zap className="w-3.5 h-3.5" />
                    +48V
                  </button>
                  <button
                    type="button"
                    disabled={locked || !selectedAssigned}
                    onClick={() =>
                      onUpdateChannel(selectedChannel.id, {
                        padDb: !selectedChannel.padDb,
                      })
                    }
                    className={`py-2 rounded font-bold border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-[11px] hw-key ${
                      selectedAssigned && selectedChannel.padDb
                        ? '!bg-none !border-amber-300 !bg-amber-500 !text-slate-950 shadow-[0_0_10px_rgba(245,158,11,0.6)]'
                        : ''
                    }`}
                  >
                    -20 dB PAD
                  </button>
                </div>
                <button
                  type="button"
                  disabled={locked || !selectedAssigned}
                  onClick={() =>
                    onUpdateChannel(selectedChannel.id, {
                      polarityInverted: !selectedChannel.polarityInverted,
                    })
                  }
                  title={
                    selectedAssigned && selectedChannel.polarityInverted
                      ? 'Polarity inverted (180°)'
                      : 'Polarity normal (0°)'
                  }
                  className={`py-1.5 rounded font-bold border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-[11px] hw-key ${
                    selectedAssigned && selectedChannel.polarityInverted
                      ? '!bg-none !border-sky-300 !bg-sky-500 !text-slate-950'
                      : ''
                  }`}
                >
                  POLARITY {selectedAssigned && selectedChannel.polarityInverted ? 'Ø 180°' : '0°'}
                </button>
              </div>

              {/* Group C: Mains Hum Notch Trap */}
              <div className="h-full rounded-lg border border-emerald-500/25 bg-[#08100E] p-3 flex flex-col justify-center gap-2 font-mono text-xs">
                <span className="hw-engraved !text-emerald-300 text-[10px] uppercase font-bold tracking-wider">
                  Mains Hum Notch Trap
                </span>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['off', '50hz', '60hz'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() =>
                        onUpdateDsp({
                          cleanStandby: {
                            ...dsp.cleanStandby,
                            mainsHumNotch: mode,
                            dcBlockerEnabled: true,
                            adaptiveStandbyGate: true,
                            standbyGateThresholdDb: dsp.cleanStandby?.standbyGateThresholdDb ?? -64,
                          },
                        })
                      }
                      className={`py-2 rounded font-bold text-[11px] border transition cursor-pointer hw-key ${
                        dsp.cleanStandby?.mainsHumNotch === mode
                          ? '!bg-none !border-emerald-300 !bg-emerald-500 !text-slate-950 shadow-[0_0_10px_rgba(16,185,129,0.5)]'
                          : ''
                      }`}
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
                <span
                  className="hw-engraved font-mono text-[9px] font-bold tracking-wider uppercase"
                  title="Eliminates 50/60 Hz AC ground hum & harmonics with zero phase smear — pick your mains region"
                >
                  50/60 HZ AC HUM
                </span>
              </div>
            </div>

            {selMode === 'inst' ? (
              <div
                className="px-3 py-1.5 rounded border border-fuchsia-500/40 bg-[#0D0812] shrink-0"
                title={INSTRUMENT_RIG_CHECKLIST.map((n, i) => `${i + 1}. ${n}`).join('\n')}
              >
                <div className="flex items-center justify-between font-mono text-[10px] font-bold tracking-wider uppercase">
                  <span
                    className="text-fuchsia-300"
                    title={`Instrument Rig Checklist — Guitar / Bass (Hi-Z · CH${selectedChannel.index})`}
                  >
                    INST RIG · CH{selectedChannel.index}
                  </span>
                  <span className="text-emerald-400 font-semibold">48V LOCKED · PAD READY · NOTCH ARMED</span>
                </div>
                <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[9px] leading-snug text-slate-300">
                  {INSTRUMENT_RIG_CHECKLIST.slice(0, 3).map((note, i) => (
                    <span key={i} className="flex items-center gap-1.5 min-w-0" title={note}>
                      <span className="text-fuchsia-400 font-bold shrink-0">{i + 1}.</span>
                      <span className="sr-only">{note}</span>
                      <span
                        className="hw-lamp shrink-0"
                        data-on="green"
                        style={{ width: 5, height: 5 }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 truncate font-bold tracking-wider uppercase">
                        {INSTRUMENT_RIG_KEYS[i] ?? `CHK ${i + 1}`}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="px-3 py-1.5 rounded border border-slate-800 bg-[#050609] flex items-center justify-between font-mono text-[9px] font-bold tracking-wider uppercase shrink-0">
                <span className="flex items-center gap-1.5 text-slate-400" title="Subsonic DC protection: 18 Hz Butterworth, always active ahead of the fader">
                  <span className="hw-lamp" data-on="cyan" style={{ width: 5, height: 5 }} aria-hidden="true" /> DC GUARD 18 HZ BW
                </span>
                <span className="flex items-center gap-1.5 text-emerald-400" title="PFL headroom: +18 dBFS">
                  PFL +18 DBFS
                </span>
              </div>
            )}
          </div>
        )}

        {/* PHASE 2: HPF/LPF FILTERS & ZERO-HUM STANDBY GATE */}
        {selectedPhase === 'phase-2-filters' && (
          <div className="h-full min-h-0 flex flex-col justify-between p-3 rounded-lg border border-cyan-500/40 bg-gradient-to-b from-[#0A171C] via-[#071014] to-[#04090C] shadow-inner">
            <div className="flex items-center justify-between border-b border-cyan-500/25 pb-1.5 shrink-0">
              <div className="flex items-center gap-2">
                <span className="hw-lamp" data-on="cyan" style={{ width: 6, height: 6 }} aria-hidden="true" />
                <h3 className="font-mono text-xs font-bold text-cyan-100 tracking-wider uppercase">
                  PHASE 2 · BANDPASS FILTERS &amp; NOISE GATE — {selectedChannel.name}
                </h3>
              </div>
              <span className="font-mono text-[11px] text-emerald-400 font-semibold">
                Floor: {telemetry.noiseFloorDb.toFixed(1)} dBFS
              </span>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-2 gap-3 py-2 items-center">
              {/* Group A: Steep Surgical Filters */}
              <div className="h-full rounded-lg border border-cyan-500/30 bg-[#061116] p-3 flex flex-col justify-between">
                <div className="flex items-center justify-between font-mono text-[10px]">
                  <span className="hw-engraved !text-cyan-300 font-bold uppercase tracking-wider">
                    18 dB/Oct Butterworth Filters
                  </span>
                  <button
                    type="button"
                    onClick={() => onUpdateDsp({ hpfEnabled: !dsp.hpfEnabled })}
                    className={`px-2 py-0.5 rounded font-bold border cursor-pointer hw-key ${
                      dsp.hpfEnabled
                        ? '!bg-none !border-cyan-300 !bg-cyan-500 !text-slate-950'
                        : ''
                    }`}
                  >
                    {dsp.hpfEnabled ? 'HPF IN' : 'HPF OUT'}
                  </button>
                </div>
                <div className="flex items-center justify-around">
                  <RotaryKnob
                    label="High-Pass (HPF)"
                    value={dsp.hpfHz}
                    min={20}
                    max={300}
                    step={5}
                    defaultValue={80}
                    unit="Hz"
                    size={64}
                    accent="sky"
                    onChange={(v) => onUpdateDsp({ hpfHz: v, hpfEnabled: true })}
                  />
                  <RotaryKnob
                    label="Low-Pass (LPF)"
                    value={dsp.lpfHz}
                    min={4000}
                    max={20000}
                    step={250}
                    defaultValue={18000}
                    unit="Hz"
                    size={64}
                    accent="sky"
                    onChange={(v) => onUpdateDsp({ lpfHz: v, lpfEnabled: true })}
                  />
                </div>
              </div>

              {/* Group B: Expander / Standby Gate */}
              <div className="h-full rounded-lg border border-emerald-500/30 bg-[#071410] p-3 flex flex-col justify-between">
                <div className="flex items-center justify-between font-mono text-[10px]">
                  <span className="hw-engraved !text-emerald-300 font-bold uppercase tracking-wider">
                    Expander / Standby Gate
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateDsp({ gate: { ...dsp.gate, enabled: !dsp.gate.enabled } })
                    }
                    className={`px-2 py-0.5 rounded font-bold border cursor-pointer hw-key ${
                      dsp.gate.enabled
                        ? '!bg-none !border-emerald-300 !bg-emerald-500 !text-slate-950'
                        : ''
                    }`}
                  >
                    {dsp.gate.enabled ? 'GATE ACTIVE' : 'BYPASSED'}
                  </button>
                </div>
                <div className="flex items-center justify-around">
                  <RotaryKnob
                    label="Gate Thresh"
                    value={dsp.gate.thresholdDb}
                    min={-60}
                    max={-12}
                    step={1}
                    defaultValue={-42}
                    unit="dB"
                    size={64}
                    accent="emerald"
                    onChange={(v) =>
                      onUpdateDsp({ gate: { ...dsp.gate, thresholdDb: v, enabled: true } })
                    }
                  />
                  <RotaryKnob
                    label="Gate Depth"
                    value={dsp.gate.rangeDb}
                    min={6}
                    max={48}
                    step={2}
                    defaultValue={24}
                    unit="dB"
                    size={64}
                    accent="amber"
                    onChange={(v) =>
                      onUpdateDsp({ gate: { ...dsp.gate, rangeDb: v, enabled: true } })
                    }
                  />
                </div>
              </div>
            </div>

            <div className="px-3 py-1.5 rounded border border-slate-800 bg-[#05080A] flex items-center justify-between font-mono text-[11px] text-slate-400 shrink-0">
              <span
                className="hw-engraved uppercase"
                title="Removes stage floor rumble, mic handling thumps & idle room hiss."
              >
                RUMBLE · THUMP · HISS
              </span>
              <span className="text-cyan-400 font-semibold">
                HPF: {dsp.hpfHz} Hz · LPF: {(dsp.lpfHz / 1000).toFixed(1)} kHz
              </span>
            </div>
          </div>
        )}

        {/* PHASE 3: 4-BAND PARAMETRIC EQ & LIVE FFT RTA */}
        {selectedPhase === 'phase-3-peq' && (
          <div className="h-full min-h-0 flex flex-col justify-between gap-2 p-2.5 rounded-lg border border-sky-500/35 bg-[#0A0F1A] shadow-inner">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 shrink-0">
              <div className="flex items-center gap-2">
                <span className="hw-lamp" data-on="cyan" style={{ width: 6, height: 6 }} aria-hidden="true" />
                <h3 className="font-mono text-xs font-bold text-white tracking-wider uppercase">
                  PHASE 3 · 4-BAND PARAMETRIC EQ &amp; LIVE RTA — {selectedChannel.name}
                </h3>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span
                  className="hw-engraved uppercase"
                  title={`Bands: ${dsp.eqBands.length} · ±18 dB`}
                >
                  BANDS {dsp.eqBands.length} · ±18 dB
                </span>
                {dsp.eqBands.length > 4 && (
                  <button
                    type="button"
                    onClick={() =>
                      setPeqPageOffset((p) => (p + 4 >= dsp.eqBands.length ? 0 : p + 4))
                    }
                    className="px-2 py-0.5 rounded border font-bold cursor-pointer hw-key !bg-none !border-sky-500/50 !bg-sky-500/15 !text-sky-200 hover:!bg-sky-500/30"
                  >
                    BANDS {peqPageOffset + 1}–{Math.min(dsp.eqBands.length, peqPageOffset + 4)} ▸
                  </button>
                )}
                {onAddEqBand && (
                  <button
                    type="button"
                    onClick={() => {
                      onAddEqBand();
                      if (dsp.eqBands.length >= 4) {
                        setPeqPageOffset(Math.floor(dsp.eqBands.length / 4) * 4);
                      }
                    }}
                    className="px-2 py-0.5 rounded border font-bold cursor-pointer hw-key !bg-none !border-emerald-500/50 !bg-emerald-500/15 !text-emerald-200 hover:!bg-emerald-500/30"
                  >
                    + BAND
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    onUpdateDsp({
                      eqBands: dsp.eqBands.map((b) => ({ ...b, gainDb: 0 })),
                    })
                  }
                  className="px-2 py-0.5 rounded border cursor-pointer flex items-center gap-1 font-bold hw-key"
                >
                  <RotateCcw className="w-3 h-3 text-sky-400" />
                  FLAT RESET
                </button>
              </div>
            </div>

            {/* Adaptive OLED RTA & EQ Transfer Curve Screen */}
            <div className="relative flex-1 min-h-[56px] w-full bg-[#030509] rounded border border-slate-800 overflow-hidden shadow-[inset_0_2px_12px_rgba(0,0,0,0.9)]">
              <div className="absolute inset-0 flex flex-col justify-between px-2.5 py-1.5 pointer-events-none opacity-30 font-mono text-[9px] text-slate-400">
                <div className="flex justify-between">
                  <span>+18 dB</span>
                  <span>100 Hz</span>
                  <span>1 kHz</span>
                  <span>10 kHz</span>
                </div>
                <div className="w-full border-b border-dashed border-slate-600" />
                <div className="flex justify-between">
                  <span>-18 dB</span>
                  <span>20 Hz</span>
                  <span>500 Hz</span>
                  <span>20 kHz</span>
                </div>
              </div>

              <svg
                viewBox="0 0 640 130"
                preserveAspectRatio="none"
                className="w-full h-full overflow-hidden"
              >
                <defs>
                  <linearGradient id="peqAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.24" />
                    <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <line
                  x1="0"
                  y1={peqGeometry.midY}
                  x2="640"
                  y2={peqGeometry.midY}
                  stroke="#334155"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <path d={peqGeometry.area} fill="url(#peqAreaGrad)" />
                <path
                  d={peqGeometry.path}
                  fill="none"
                  stroke="#38BDF8"
                  strokeWidth="2.5"
                  className="drop-shadow-[0_0_8px_rgba(56,189,248,0.7)]"
                />
                {peqGeometry.nodes.map((node) => (
                  <circle
                    key={node.id}
                    cx={node.x}
                    cy={node.y}
                    r={node.enabled ? 5 : 3.5}
                    fill={node.enabled ? node.color : '#475569'}
                    stroke="#030509"
                    strokeWidth="1.5"
                  />
                ))}
              </svg>
            </div>

            {/* 4 Color-Coded Hardware Parametric Band Modules (Paged across Unlimited Bands) */}
            <div className="shrink-0 grid grid-cols-4 gap-2">
              {dsp.eqBands.slice(peqPageOffset, peqPageOffset + 4).map((band, idx) => {
                const style = PEQ_BAND_STYLES[idx % 4] ?? PEQ_BAND_STYLES[3];
                return (
                  <div
                    key={band.id}
                    className={`rounded-lg border px-2 py-1.5 flex flex-col justify-between gap-1 ${style.card}`}
                  >
                    <div className="flex items-center justify-between gap-1 font-mono text-[10px]">
                      <span className={`px-1.5 py-0.5 rounded border font-bold truncate ${style.badge}`}>
                        {style.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = dsp.eqBands.map((b) =>
                            b.id === band.id ? { ...b, enabled: !b.enabled } : b
                          );
                          onUpdateDsp({ eqBands: updated });
                        }}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold border cursor-pointer shrink-0 hw-key ${
                          band.enabled
                            ? '!bg-none !border-emerald-300 !bg-emerald-500 !text-slate-950'
                            : ''
                        }`}
                      >
                        {band.enabled ? 'IN' : 'OUT'}
                      </button>
                    </div>

                    <div className="flex items-center justify-around gap-1">
                      <RotaryKnob
                        label="Gain"
                        value={band.gainDb}
                        min={-15}
                        max={15}
                        step={0.5}
                        defaultValue={0}
                        unit="dB"
                        size={36}
                        accent={style.accent}
                        onChange={(v) => {
                          const updated = dsp.eqBands.map((b) =>
                            b.id === band.id ? { ...b, gainDb: v, enabled: true } : b
                          );
                          onUpdateDsp({ eqBands: updated });
                        }}
                      />
                      <RotaryKnob
                        label="Freq"
                        value={band.frequency}
                        min={style.minHz}
                        max={style.maxHz}
                        step={10}
                        defaultValue={band.frequency}
                        unit="Hz"
                        size={36}
                        accent={style.accent}
                        onChange={(v) => {
                          const updated = dsp.eqBands.map((b) =>
                            b.id === band.id ? { ...b, frequency: v, enabled: true } : b
                          );
                          onUpdateDsp({ eqBands: updated });
                        }}
                      />
                      <RotaryKnob
                        label="Q"
                        value={band.q}
                        min={0.4}
                        max={8}
                        step={0.1}
                        defaultValue={1.4}
                        size={36}
                        accent={style.accent}
                        onChange={(v) => {
                          const updated = dsp.eqBands.map((b) =>
                            b.id === band.id ? { ...b, q: v, enabled: true } : b
                          );
                          onUpdateDsp({ eqBands: updated });
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* PHASE 4: VCA DYNAMICS COMPRESSOR & GAIN REDUCTION LADDER */}
        {selectedPhase === 'phase-4-dynamics' && (
          <div className="h-full min-h-0 flex flex-col justify-between p-3 rounded-lg border border-emerald-500/40 bg-gradient-to-b from-[#091813] via-[#06100D] to-[#040907] shadow-inner">
            <div className="flex items-center justify-between border-b border-emerald-500/25 pb-1.5 shrink-0">
              <div className="flex items-center gap-2">
                <span className="hw-lamp" data-on="green" style={{ width: 6, height: 6 }} aria-hidden="true" />
                <h3 className="font-mono text-xs font-bold text-emerald-100 tracking-wider uppercase">
                  PHASE 4 · VCA DYNAMICS COMPRESSOR &amp; DE-ESSER — {selectedChannel.name}
                </h3>
              </div>
              <span className="font-mono text-xs text-amber-400 font-bold">
                GR: -{Math.abs(telemetry.gainReductionDb).toFixed(1)} dB
              </span>
            </div>

            <div className="flex-1 min-h-0 flex items-center gap-3 py-2">
              {/* 12-Segment Gain Reduction LED Meter */}
              <div className="h-full w-20 shrink-0 rounded-lg border border-slate-700/80 bg-[#05080B] p-2 flex flex-col items-center justify-between font-mono">
                <span className="text-[9px] font-bold text-amber-400">GR (dB)</span>
                <div className="hw-led-track flex-1 w-5">
                  {Array.from({ length: grSegments }).map((_, idx) => {
                    const lit = idx < activeGrCount;
                    return (
                      <span
                        key={idx}
                        className="hw-led-seg"
                        data-lit={lit ? (idx > 8 ? 'red' : 'amber') : undefined}
                      />
                    );
                  })}
                </div>
                <span className="hw-lcd rounded px-1 text-[10px] text-slate-300 font-bold tabular-nums">
                  -{Math.abs(telemetry.gainReductionDb).toFixed(1)}
                </span>
              </div>

              {/* 5 Grouped Compressor Controls */}
              <div className="flex-1 h-full rounded-lg border border-emerald-500/25 bg-[#060E0B] grid grid-cols-5 gap-2 items-center justify-items-center p-2">
                <RotaryKnob
                  label="Threshold"
                  value={dsp.compressor.thresholdDb}
                  min={-48}
                  max={0}
                  step={1}
                  defaultValue={-18}
                  unit="dB"
                  size={60}
                  accent="amber"
                  onChange={(v) =>
                    onUpdateDsp({
                      compressor: { ...dsp.compressor, thresholdDb: v, enabled: true },
                    })
                  }
                />
                <RotaryKnob
                  label="Ratio"
                  value={dsp.compressor.ratio}
                  min={1}
                  max={16}
                  step={0.5}
                  defaultValue={3}
                  unit=":1"
                  size={60}
                  accent="emerald"
                  onChange={(v) =>
                    onUpdateDsp({
                      compressor: { ...dsp.compressor, ratio: v, enabled: true },
                    })
                  }
                />
                <RotaryKnob
                  label="Attack"
                  value={dsp.compressor.attackMs}
                  min={1}
                  max={100}
                  step={1}
                  defaultValue={15}
                  unit="ms"
                  size={60}
                  accent="sky"
                  onChange={(v) =>
                    onUpdateDsp({
                      compressor: { ...dsp.compressor, attackMs: v, enabled: true },
                    })
                  }
                />
                <RotaryKnob
                  label="Release"
                  value={dsp.compressor.releaseMs}
                  min={20}
                  max={800}
                  step={10}
                  defaultValue={120}
                  unit="ms"
                  size={60}
                  accent="sky"
                  onChange={(v) =>
                    onUpdateDsp({
                      compressor: { ...dsp.compressor, releaseMs: v, enabled: true },
                    })
                  }
                />
                <RotaryKnob
                  label="Makeup"
                  value={dsp.compressor.makeupDb}
                  min={0}
                  max={18}
                  step={0.5}
                  defaultValue={0}
                  unit="dB"
                  size={60}
                  accent="emerald"
                  onChange={(v) =>
                    onUpdateDsp({
                      compressor: { ...dsp.compressor, makeupDb: v, enabled: true },
                    })
                  }
                />
              </div>
            </div>

            <div className="px-3 py-1.5 rounded border border-slate-800 bg-[#050807] flex items-center justify-between font-mono text-[11px] shrink-0">
              <span
                className="hw-engraved uppercase"
                title="Smooth RMS VCA peak-leveler with transparent auto-release."
              >
                RMS VCA · AUTO RELEASE
              </span>
              <button
                type="button"
                onClick={() =>
                  onUpdateDsp({
                    compressor: { ...dsp.compressor, enabled: !dsp.compressor.enabled },
                  })
                }
                className={`px-3 py-1 rounded text-[11px] font-bold border transition cursor-pointer hw-key ${
                  dsp.compressor.enabled
                    ? '!bg-none !border-emerald-300 !bg-emerald-500 !text-slate-950'
                    : ''
                }`}
              >
                {dsp.compressor.enabled ? 'COMPRESSOR ACTIVE' : 'BYPASSED'}
              </button>
            </div>
          </div>
        )}

        {/* PHASE 5: PRO STEREO 31-BAND GRAPHIC EQUALIZER */}
        {selectedPhase === 'phase-5-geq' && (
          <div className="h-full min-h-0 overflow-hidden flex flex-col">
            <StereoGraphicEqModule dsp={dsp} onUpdateDsp={onUpdateDsp} compactConsoleMode />
          </div>
        )}

        {/* PHASE 6: ACTIVE 3-WAY LINKWITZ-RILEY CROSSOVER */}
        {selectedPhase === 'phase-6-xover' && (
          <div className="h-full min-h-0 overflow-hidden flex flex-col">
            <ActiveCrossoverModule dsp={dsp} onUpdateDsp={onUpdateDsp} compactConsoleMode />
          </div>
        )}

        {/* PHASE 7: OUTPUT MATRIX & BRICKWALL PEAK LIMITER */}
        {selectedPhase === 'phase-7-matrix' && (
          <div className="h-full min-h-0 flex flex-col justify-between p-3 rounded-lg border border-orange-500/40 bg-gradient-to-b from-[#1A100A] via-[#100B07] to-[#080604] shadow-inner">
            <div className="flex items-center justify-between border-b border-orange-500/25 pb-1.5 shrink-0">
              <div className="flex items-center gap-2">
                <span className="hw-lamp" data-on="amber" style={{ width: 6, height: 6 }} aria-hidden="true" />
                <h3 className="font-mono text-xs font-bold text-orange-100 tracking-wider uppercase">
                  PHASE 7 · OUTPUT BUS MATRIX &amp; SPEAKER PEAK LIMITER
                </h3>
              </div>
              <span className="font-mono text-xs text-orange-300 font-bold">
                Ceiling: {dsp.limiter.ceilingDb.toFixed(1)} dBFS
              </span>
            </div>

            <div className="flex-1 min-h-0 grid grid-cols-3 gap-3 py-2 items-center">
              <div className="h-full rounded-lg border border-red-500/30 bg-[#120909] p-3 flex items-center justify-center">
                <RotaryKnob
                  label="Brickwall Ceiling"
                  value={dsp.limiter.ceilingDb}
                  min={-12}
                  max={0}
                  step={0.5}
                  defaultValue={-0.5}
                  unit="dBFS"
                  size={64}
                  accent="red"
                  onChange={(v) =>
                    onUpdateDsp({
                      limiter: { ...dsp.limiter, ceilingDb: v, enabled: true },
                    })
                  }
                />
              </div>

              <div className="h-full rounded-lg border border-amber-500/30 bg-[#120E08] p-3 flex items-center justify-center">
                <RotaryKnob
                  label="Master Delay"
                  value={dsp.masterDelayMs}
                  min={0}
                  max={200}
                  step={1}
                  defaultValue={0}
                  unit="ms"
                  size={64}
                  accent="amber"
                  onChange={(v) => onUpdateDsp({ masterDelayMs: v })}
                />
              </div>

              <div className="h-full rounded-lg border border-slate-700/80 bg-[#0A0C12] p-3 flex flex-col justify-center gap-1.5 font-mono text-[10px]">
                <span
                  className="hw-engraved uppercase font-bold"
                  title={`Active Matrix Outputs (${zones.length || 3} Zones)`}
                >
                  MATRIX OUTPUTS · {zones.length || 3} ZONES
                </span>
                <div className="flex justify-between bg-[#05070B] px-2.5 py-1.5 rounded border border-slate-800">
                  <span title="Main Sanctuary PA L/R">MAIN PA L/R</span>
                  <span className="text-emerald-400 font-bold">ACTIVE · 0.0 ms</span>
                </div>
                <div className="flex justify-between bg-[#05070B] px-2.5 py-1.5 rounded border border-slate-800">
                  <span title="Aux 1 Dedicated Sub Array">AUX 1 · SUB ARRAY</span>
                  <span className="text-fuchsia-400 font-bold">ACTIVE · 4.5 ms</span>
                </div>
                <div className="flex justify-between bg-[#05070B] px-2.5 py-1.5 rounded border border-slate-800">
                  <span title="Matrix 2 Balcony Delays">MTX 2 · BALCONY</span>
                  <span className="text-sky-400 font-bold">ACTIVE · 24.2 ms</span>
                </div>
              </div>
            </div>

            <div className="px-3 py-1.5 rounded border border-slate-800 bg-[#070504] flex items-center justify-between font-mono text-[11px] shrink-0">
              <span
                className="hw-engraved uppercase"
                title="0 ms Lookahead True-Peak Limiter prevents horn clipping & speaker thermal overload."
              >
                TRUE-PEAK · 0 MS LOOKAHEAD
              </span>
              <button
                type="button"
                onClick={() =>
                  onUpdateDsp({
                    limiter: { ...dsp.limiter, enabled: !dsp.limiter.enabled },
                  })
                }
                className={`px-3 py-1 rounded text-[11px] font-bold border transition cursor-pointer hw-key ${
                  dsp.limiter.enabled
                    ? '!bg-none !border-orange-300 !bg-orange-500 !text-slate-950'
                    : ''
                }`}
              >
                {dsp.limiter.enabled ? 'LIMITER ENGAGED' : 'BYPASSED'}
              </button>
            </div>
          </div>
        )}
        </div>
      </div>

    </div>
  );
};
