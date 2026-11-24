import React, { useEffect, useState } from 'react';
import {
  Mic,
  Volume2,
  RefreshCw,
  Plus,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Headphones,
  Radio,
  Speaker,
  Check,
  Cable,
} from 'lucide-react';
import type {
  AudioSourceSimulation,
  ChannelInputMode,
  InputChannel,
  SpeakerZone,
  SignalTelemetry,
} from '../types/audio.ts';
import { liveAudioEngine } from '../audio/liveAudioEngine.ts';
import {
  INPUT_MODES,
  INPUT_MODE_ORDER,
  clampGainForMode,
  getInputMode,
} from '../utils/inputMode.ts';
import type {
  SpecializedDesktopInterface,
  SystemAudioBridgeState,
} from '../audio/systemAudioBridge.ts';
import {
  NATIVE_APP_AUDIO_PREFIX,
  type DesktopAudioSession,
  type DesktopAudioStatus,
} from '../utils/nativeDesktopAudio.ts';
import { deriveAutoChannelNameAndRole } from '../utils/audioNaming.ts';
import {
  buildAutoJackAssignments,
  OUTPUT_JACK_SLOT_ORDER,
  type OutputJackEndpoint,
  type OutputJackSlot,
} from '../utils/jackTopology.ts';
import { isDesktopApp } from '../utils/appApi.ts';
import { openWindowsSoundSettings } from '../utils/nativeDesktopAudio.ts';
import { RotaryKnob } from './StudioControls.tsx';
import { PrecisionVerticalFader } from './PrecisionVerticalFader.tsx';

interface ConsoleLeftPanelProps {
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  channels: InputChannel[];
  selectedChannelId: string;
  preferredOutputDeviceId: string;
  preferredStreamOutputDeviceId: string;
  zones: SpeakerZone[];
  telemetry: SignalTelemetry;
  engineRunning: boolean;
  locked?: boolean;
  desktopAudioStatus?: DesktopAudioStatus | null;
  desktopAudioSessions?: DesktopAudioSession[];
  singleSpeakerMode?: boolean;
  onEnableBrowserDspSpeakers?: () => void;
  onSelectChannel: (id: string) => void;
  onUpdateChannel: (id: string, patch: Partial<InputChannel>) => void;
  onAddChannel?: (name?: string, role?: string) => void;
  onSelectOutputDevice: (deviceId: string) => void;
  onSelectStreamOutputDevice: (deviceId: string) => void;
  onScanAudioDevices?: (
    requestPermission?: boolean
  ) => Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>;
  audioSource?: AudioSourceSimulation;
  desktopBridgeState?: SystemAudioBridgeState;
  specializedDesktopInputs?: SpecializedDesktopInterface[];
  onActivateSystemAudioBridge?: () => void;
  /** Discrete 5.1/7.1 jack endpoints (probed + simulated training card). */
  outputJackEndpoints?: OutputJackEndpoint[];
  jackProbeBusy?: boolean;
  onProbeJacks?: () => void;
  onUpdateZone?: (id: string, patch: Partial<SpeakerZone>) => void;
  simulatedSurroundCard?: boolean;
  onToggleSimulatedSurroundCard?: () => void;
}

const SEGMENTS_10 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export const ConsoleLeftPanel: React.FC<ConsoleLeftPanelProps> = ({
  inputDevices = [],
  outputDevices = [],
  channels = [],
  selectedChannelId,
  preferredOutputDeviceId = '',
  preferredStreamOutputDeviceId = '',
  zones = [],
  telemetry,
  engineRunning,
  locked = false,
  desktopAudioStatus = null,
  desktopAudioSessions = [],
  singleSpeakerMode = false,
  onEnableBrowserDspSpeakers,
  onSelectChannel,
  onUpdateChannel,
  onAddChannel,
  onSelectOutputDevice,
  onSelectStreamOutputDevice,
  onScanAudioDevices,
  audioSource = 'live-mic',
  desktopBridgeState,
  specializedDesktopInputs = [],
  onActivateSystemAudioBridge,
  outputJackEndpoints = [],
  jackProbeBusy = false,
  onProbeJacks,
  onUpdateZone,
  simulatedSurroundCard = false,
  onToggleSimulatedSurroundCard,
}) => {
  const [activeTab, setActiveTab] = useState<'inputs' | 'outputs'>('inputs');
  const [collapsed, setCollapsed] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [patchTrayOpen, setPatchTrayOpen] = useState(true);
  const [fastChRms, setFastChRms] = useState<number[]>([]);
  const [fastChPeak, setFastChPeak] = useState<number[]>([]);
  const [fastPostDb, setFastPostDb] = useState(-96);
  const [fastJackRms, setFastJackRms] = useState<Partial<Record<OutputJackSlot, number>>>({});

  // Throttled ~12.5fps live hardware level meter sampling (pauses while hidden & skips unchanged silence)
  // — channel strips, post-fader bus and the discrete jack bay meters.
  useEffect(() => {
    if (!engineRunning) {
      setFastChRms([]);
      setFastChPeak([]);
      setFastPostDb(-96);
      setFastJackRms({});
      return;
    }
    let timerId: number | null = null;
    let cancelled = false;
    let prevRms: number[] = [];
    let prevPeak: number[] = [];
    let prevPost = -96;
    let prevJack: Partial<Record<OutputJackSlot, number>> = {};
    const qHalf = (v: number) => (v <= -60 ? -96 : Math.round(v * 2) / 2);
    const sameArr = (a: number[], b: number[]) =>
      a.length === b.length && a.every((val, i) => val === b[i]);

    const tick = () => {
      timerId = null;
      if (document.hidden) {
        return;
      }
      const snap = liveAudioEngine.sampleFastLevels();
      if (snap.isRunning) {
        const nextRms = snap.channelRmsDb.map(qHalf);
        const nextPeak = snap.channelPeakDb.map(qHalf);
        const nextPost = qHalf(snap.postRmsDb);
        if (!sameArr(nextRms, prevRms)) {
          prevRms = nextRms;
          setFastChRms(nextRms);
        }
        if (!sameArr(nextPeak, prevPeak)) {
          prevPeak = nextPeak;
          setFastChPeak(nextPeak);
        }
        if (nextPost !== prevPost) {
          prevPost = nextPost;
          setFastPostDb(nextPost);
        }
      }
      const jackLevels = liveAudioEngine.sampleJackLevels();
      if (jackLevels.length > 0) {
        const nextJack: Partial<Record<OutputJackSlot, number>> = {};
        for (const j of jackLevels) nextJack[j.slot as OutputJackSlot] = qHalf(j.rmsDb);
        const sameJack =
          Object.keys(nextJack).length === Object.keys(prevJack).length &&
          (Object.keys(nextJack) as OutputJackSlot[]).every((k) => nextJack[k] === prevJack[k]);
        if (!sameJack) {
          prevJack = nextJack;
          setFastJackRms(nextJack);
        }
      } else if (Object.keys(prevJack).length > 0) {
        prevJack = {};
        setFastJackRms({});
      }
      if (!cancelled) timerId = window.setTimeout(tick, 80);
    };

    const onVis = () => {
      if (!document.hidden && timerId === null) {
        tick();
      }
    };

    if (!document.hidden) tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [engineRunning]);

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? channels[0];

  const handleScan = async () => {
    setScanning(true);
    try {
      if (onScanAudioDevices) {
        await onScanAudioDevices(true);
      }
    } finally {
      setScanning(false);
    }
  };

  const classifyInput = (label: string) => {
    const l = label.toLowerCase();
    if (l.includes('desktop audio') || l.startsWith('app:')) {
      return { kind: 'Desktop Audio', dot: 'bg-cyan-400', badge: 'text-cyan-300 border-cyan-500/35 bg-cyan-950/40' };
    }
    if (l.includes('cable') || l.includes('virtual') || l.includes('voicemeeter')) {
      return { kind: 'Virtual', dot: 'bg-emerald-400', badge: 'text-emerald-300 border-emerald-500/35 bg-emerald-950/40' };
    }
    if (
      l.includes('usb') ||
      l.includes('focusrite') ||
      l.includes('behringer') ||
      l.includes('yamaha') ||
      l.includes('scarlett') ||
      l.includes('mg')
    ) {
      return { kind: 'USB Audio', dot: 'bg-sky-400', badge: 'text-sky-300 border-sky-500/35 bg-sky-950/40' };
    }
    if (l.includes('line') || l.includes('aux')) {
      return { kind: 'Line In', dot: 'bg-violet-400', badge: 'text-violet-300 border-violet-500/35 bg-violet-950/40' };
    }
    return { kind: 'Mic In', dot: 'bg-amber-400', badge: 'text-amber-300 border-amber-500/35 bg-amber-950/40' };
  };

  const classifyOutput = (label: string) => {
    const l = label.toLowerCase();
    if (l.includes('cable') || l.includes('virtual') || l.includes('voicemeeter') || l.includes('obs')) {
      return { kind: 'Virtual / OBS Bus', color: 'text-violet-300 bg-violet-950/40 border-violet-500/35', icon: Radio };
    }
    if (l.includes('headphone') || l.includes('earphone') || l.includes('bluetooth') || l.includes('buds')) {
      return { kind: 'Headphones / Cue', color: 'text-sky-300 bg-sky-950/40 border-sky-500/35', icon: Headphones };
    }
    if (
      l.includes('usb') ||
      l.includes('interface') ||
      l.includes('scarlett') ||
      l.includes('behringer') ||
      l.includes('yamaha')
    ) {
      return { kind: 'USB Audio Out', color: 'text-amber-300 bg-amber-950/40 border-amber-500/35', icon: Speaker };
    }
    return { kind: 'Speaker Output', color: 'text-emerald-300 bg-emerald-950/40 border-emerald-500/35', icon: Speaker };
  };

  const meterWidth = Math.max(0, Math.min(100, (((engineRunning ? fastPostDb : telemetry.postRmsDb) + 60) / 60) * 100));

  // Live engine-side jack routing status (router active/standby + driven slots)
  const [jackRouterStatus, setJackRouterStatus] = useState('ROUTER STANDBY (legacy stereo)');
  useEffect(() => {
    if (activeTab !== 'outputs') return;
    const t = window.setInterval(() => {
      const st = liveAudioEngine.getJackRoutingStatus();
      setJackRouterStatus(
        st.active
          ? `ROUTER ACTIVE · ${st.channelCount}ch · ${st.slots.length} jack${st.slots.length === 1 ? '' : 's'} driven${st.simulated ? ' · SIM' : ''}`
          : 'ROUTER STANDBY (legacy stereo)'
      );
    }, 600);
    return () => window.clearInterval(t);
  }, [activeTab]);

  if (collapsed) {
    return (
      <aside
        aria-label="Collapsed Input & Output Panel"
        className="w-10 shrink-0 h-full hw-panel rounded-lg flex flex-col items-center justify-between py-2.5 select-none"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Expand Inputs / Outputs Panel"
          className="p-1.5 rounded bg-[#0E141A] border border-[#2A3646] text-teal-300 hover:text-white cursor-pointer"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>

        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setActiveTab('inputs');
              setCollapsed(false);
            }}
            title={`Inputs (${channels.length} channels)`}
            className={`p-1.5 rounded border cursor-pointer ${
              activeTab === 'inputs'
                ? 'bg-teal-500/20 border-teal-400/60 text-teal-300'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <Mic className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('outputs');
              setCollapsed(false);
            }}
            title={`Outputs (${outputDevices.length} endpoints)`}
            className={`p-1.5 rounded border cursor-pointer ${
              activeTab === 'outputs'
                ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <span
          className={`w-2 h-2 rounded-full ${
            engineRunning ? 'bg-emerald-400 shadow-[0_0_6px_rgba(74,222,128,0.85)]' : 'bg-slate-600'
          }`}
        />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Live Console Inputs & Outputs Rack"
      className="w-[272px] 2xl:w-[300px] shrink-0 h-full hw-panel rounded-lg flex flex-col overflow-hidden select-none"
    >
      {/* Top Interchangeable Tab Header */}
      <div className="h-8 shrink-0 px-1 2xl:px-1.5 hw-card-header flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5 2xl:gap-1 flex-1 min-w-0 font-mono text-[8.5px] 2xl:text-[9.5px] font-bold">
          <button
            type="button"
            onClick={() => setActiveTab('inputs')}
            className={`flex-1 min-w-0 h-6 px-1 2xl:px-1.5 rounded flex items-center justify-center gap-0.5 2xl:gap-1 whitespace-nowrap cursor-pointer ${
              activeTab === 'inputs' ? 'hw-top-btn-active' : 'hw-top-btn'
            }`}
          >
            <Mic className="w-2.5 h-2.5 shrink-0" />
            <span>INPUTS</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('outputs')}
            className={`flex-1 min-w-0 h-6 px-1 2xl:px-1.5 rounded flex items-center justify-center gap-0.5 2xl:gap-1 whitespace-nowrap cursor-pointer ${
              activeTab === 'outputs' ? 'hw-top-btn-active' : 'hw-top-btn'
            }`}
          >
            <Volume2 className="w-2.5 h-2.5 shrink-0" />
            <span>OUT ({outputDevices.length})</span>
          </button>
        </div>

        <div className="flex items-center gap-0.5 2xl:gap-1 shrink-0">
          <button
            type="button"
            disabled={scanning}
            onClick={() => void handleScan()}
            title="Re-Scan Live Audio Hardware & Virtual Ports"
            className="p-1 rounded hw-top-btn cursor-pointer disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin text-teal-300' : ''}`} />
          </button>
          {activeTab === 'inputs' && onAddChannel && (
            <button
              type="button"
              disabled={locked}
              onClick={() => onAddChannel()}
              title="Add New Standalone Stereo Input Strip"
              className="p-1 rounded hw-top-btn cursor-pointer disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse Left Panel"
            className="p-1 rounded hw-top-btn cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* =========================================================================
          TAB 1: TAB-DRIVEN INPUT CHANNEL BAY — ONE REUSABLE SUPER INPUT STRIP
          Channel tabs across the top; the full-size strip below rebinds to
          whichever tab is selected (a real-world "selected channel edit" page:
          Behringer X32 channel view / PreSonus Fat Channel style).
          ========================================================================= */}
      {activeTab === 'inputs' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* ---- Channel selector tab rail: one tab per input + live mini meters ---- */}
          <div className="shrink-0 px-1.5 pt-1.5">
            <div className="flex items-center justify-between px-0.5 pb-1 font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400">
              <span>Channel Tabs</span>
              <span className="text-slate-500 tabular-nums normal-case tracking-normal">
                {channels.length} Inputs
              </span>
            </div>
            <div className="grid grid-cols-8 gap-1 max-h-[118px] overflow-y-auto pr-0.5">
              {channels.map((ch, i) => {
                const tabSelected = ch.id === selectedChannel?.id;
                const tabBridge =
                  ch.index === 1 && (audioSource === 'desktop-audio' || audioSource === 'pink-noise');
                const tabAssigned = Boolean(ch.hardwareInputId) || tabBridge;
                const tRms =
                  tabAssigned && engineRunning && !ch.mute
                    ? fastChRms[i] ?? telemetry.channelLevels?.[i]?.rmsDb ?? -96
                    : -96;
                const tPeak =
                  tabAssigned && engineRunning && !ch.mute
                    ? fastChPeak[i] ?? telemetry.channelLevels?.[i]?.peakDb ?? -96
                    : -96;
                const tNorm = Math.max(0, Math.min(1, (tRms + 54) / 54));
                const tabHot = tabAssigned && tPeak > -2.5;
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => onSelectChannel(ch.id)}
                    aria-pressed={tabSelected}
                    title={`CH ${ch.index} — ${ch.name}${
                      tabAssigned ? ` (${ch.hardwareInputLabel || ch.role})` : ' · Open Slot'
                    } — click to load this channel into the input strip`}
                    className={`relative h-8 rounded border font-mono text-[11px] font-bold overflow-hidden cursor-pointer transition-all shrink-0 ${
                      tabSelected
                        ? 'border-teal-300 bg-[#17282D] text-white ring-1 ring-[#2DD4BF]/45 shadow-[0_0_8px_rgba(45,212,191,0.35)] z-10'
                        : tabAssigned
                          ? tabHot
                            ? 'border-amber-400/80 bg-gradient-to-b from-[#2A2015] to-[#161009] text-amber-200'
                            : 'border-[#4B5D72] bg-gradient-to-b from-[#1E2732] to-[#131921] text-slate-200 hover:border-[#687F99] hover:text-white'
                          : 'border-dashed border-[#2A3544] bg-[#0D1219]/70 text-slate-500 hover:text-slate-200'
                    } ${ch.mute && tabAssigned ? 'text-rose-300' : ''}`}
                  >
                    {/* live mini level fill rising from the bottom of the tab */}
                    {tabAssigned && !ch.mute && tNorm > 0.02 && (
                      <span
                        className={`absolute bottom-0 left-0 right-0 z-0 pointer-events-none transition-[height] duration-75 ${
                          tNorm > 0.93
                            ? 'bg-rose-500/45'
                            : tNorm > 0.8
                              ? 'bg-amber-400/40'
                              : 'bg-emerald-400/30'
                        }`}
                        style={{ height: `${Math.round(tNorm * 100)}%` }}
                      />
                    )}
                    <span className="relative z-10 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                      {ch.index}
                    </span>
                    {ch.solo && tabAssigned && (
                      <span
                        title="Solo engaged"
                        className="absolute top-0 left-0 w-1.5 h-1.5 rounded-br bg-amber-400 z-10 pointer-events-none"
                      />
                    )}
                    {ch.mute && tabAssigned && (
                      <span
                        title="Muted"
                        className="absolute top-0 right-0 w-1.5 h-1.5 rounded-bl bg-rose-500 z-10 pointer-events-none"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ---- SUPER INPUT STRIP: one full-size reusable control surface that
                reloads with whichever channel tab is selected above ---- */}
          {selectedChannel ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1.5">
              {(() => {
                const ch = selectedChannel;
                const globalIdx = channels.findIndex((c) => c.id === ch.id);
                const isBridgeSlot =
                  ch.index === 1 && (audioSource === 'desktop-audio' || audioSource === 'pink-noise');
                const isAssigned = Boolean(ch.hardwareInputId) || isBridgeSlot;
                const rmsDb =
                  isAssigned && engineRunning && !ch.mute
                    ? fastChRms[globalIdx] ?? telemetry.channelLevels?.[globalIdx]?.rmsDb ?? ch.levelDb
                    : -96;
                const peakDb =
                  isAssigned && engineRunning && !ch.mute
                    ? fastChPeak[globalIdx] ?? telemetry.channelLevels?.[globalIdx]?.peakDb ?? ch.peakDb
                    : -96;
                const isHot =
                  isAssigned && ((engineRunning && !ch.mute && peakDb > -2.5) || ch.faderDb > 4.5 || ch.gainDb > 46);
                const normMeter =
                  isAssigned && engineRunning && !ch.mute ? Math.max(0, Math.min(1, (rmsDb + 54) / 54)) : 0;
                const litSegments =
                  isAssigned && engineRunning && !ch.mute && rmsDb > -53 ? Math.max(1, Math.round(normMeter * 10)) : 0;
                const stripDisabled = Boolean(locked || !isAssigned);
                const isMainPaAssigned = ch.mainPaAssign ?? true;
                const isStreamAssigned = ch.streamAssign ?? true;
                const isSubAssigned = ch.subAssign ?? false;
                const fmtDb = (v: number) => (v <= -60 ? '−∞' : v.toFixed(1));

                // Real-world console input section: MIC / LINE / INST source switch
                const chMode = getInputMode(ch);
                const modeSpec = INPUT_MODES[chMode];

                const switchInputMode = (next: ChannelInputMode) => {
                  const patch: Partial<InputChannel> = { inputMode: next };
                  // Hardware interlock: +48V only exists on the mic domain — auto-disengage
                  // exactly like smart consoles (sending phantom into a guitar/DI can destroy it).
                  if (next !== 'mic' && ch.phantom48v) patch.phantom48v = false;
                  // Re-scale stored preamp gain into the new mode's silkscreen range.
                  patch.gainDb = clampGainForMode(ch.gainDb, next);
                  onUpdateChannel(ch.id, patch);
                };

                const gainRangeNote =
                  chMode === 'line'
                    ? 'Trim −12..+12 dB · Unity 0 · Target −18 dBFS'
                    : `Range +${modeSpec.gainMin}..+${modeSpec.gainMax} dB · Unity +${modeSpec.unityGainDb} · Target ${modeSpec.stagingTargetRmsDb} dBFS`;

                return (
                  <>
                    {/* ==== Section 1: Channel identity header ==== */}
                    <div
                      className={`rounded-md border p-2 flex items-center gap-2.5 shrink-0 transition-all ${
                        !isAssigned
                          ? 'border-dashed border-[#3A4B5E] bg-[#0F151D]/80'
                          : isHot
                            ? 'border-amber-400 bg-gradient-to-b from-[#2A2015] to-[#1A130D] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_10px_rgba(245,158,11,0.3)]'
                            : 'border-[#2DD4BF]/70 bg-gradient-to-b from-[#17282D] to-[#111D22] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_0_10px_rgba(45,212,191,0.22)]'
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-md border flex items-center justify-center font-mono text-[16px] font-bold shrink-0 ${
                          !isAssigned
                            ? 'border-[#2A3544] bg-[#0B1017] text-slate-600'
                            : isHot
                              ? 'border-amber-300/70 bg-amber-950/60 text-amber-200'
                              : 'border-teal-300/60 bg-[#0E2A2E] text-[#5EEAD4]'
                        }`}
                        aria-label={`Channel ${ch.index}`}
                      >
                        {ch.index}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-[13px] font-semibold text-slate-100 truncate leading-tight"
                          title={`${ch.name} — CH ${ch.index}`}
                        >
                          {ch.name}
                        </div>
                        <div
                          className="font-mono text-[8.5px] text-slate-400 truncate leading-tight mt-1"
                          title={
                            isAssigned
                              ? `${ch.role} · ${ch.hardwareInputLabel || 'Engine Bridge'}`
                              : 'Open Slot — assign a hardware input in the patch tray below'
                          }
                        >
                          {isAssigned
                            ? `${ch.role} · ${ch.hardwareInputLabel || (isBridgeSlot ? 'Engine Bridge' : ch.role)}`
                            : 'OPEN SLOT — assign a hardware input below'}
                        </div>
                      </div>
                      {!isAssigned ? (
                        <span className="w-2 h-2 rounded-full bg-[#1B232E] shrink-0" />
                      ) : isHot ? (
                        <AlertTriangle
                          className="w-4 h-4 text-amber-400 animate-pulse shrink-0"
                          aria-label="Signal hot — near limit"
                        />
                      ) : (
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            ch.mute
                              ? 'bg-rose-500'
                              : engineRunning && rmsDb > -52
                                ? 'bg-[#4ADE80] shadow-[0_0_6px_rgba(74,222,128,0.85)]'
                                : 'bg-slate-600'
                          }`}
                        />
                      )}
                    </div>

                    {/* ==== Section 2: Input source — MIC / LINE / INST + 48V · PAD · Ø ==== */}
                    <div
                      className={`rounded-md border p-1.5 flex flex-col gap-1.5 shrink-0 ${
                        !isAssigned
                          ? 'border-[#232E3C] bg-[#0C1117]/70 opacity-80'
                          : 'border-[#4B5D72] bg-gradient-to-b from-[#1E2732] to-[#131921] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                      }`}
                    >
                      <div className="flex items-center justify-between px-1 min-w-0">
                        <span className="font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400 shrink-0">
                          Input Source
                        </span>
                        <span
                          className="font-mono text-[8px] text-slate-500 truncate"
                          title={modeSpec.fullLabel}
                        >
                          {modeSpec.domainNote}
                        </span>
                      </div>

                      {/* MIC / LINE / INST — 3-way hardware source selector */}
                      <div
                        className="grid grid-cols-3 gap-1"
                        role="radiogroup"
                        aria-label={`Channel ${ch.index} input source mode`}
                      >
                        {INPUT_MODE_ORDER.map((m) => {
                          const active = chMode === m;
                          const spec = INPUT_MODES[m];
                          return (
                            <button
                              key={m}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              disabled={locked}
                              onClick={() => switchInputMode(m)}
                              title={`${spec.fullLabel} — ${spec.domainNote}${
                                m === 'inst'
                                  ? ' · Guitar/bass via Hi-Z jack or DI. Phantom locked out.'
                                  : m === 'line'
                                    ? ' · Keys/playback submixers. No phantom on jacks.'
                                    : ' · Condenser mics. +48V available.'
                              }`}
                              className={`h-8 rounded border font-mono text-[10px] font-bold tracking-wider transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                                active
                                  ? m === 'mic'
                                    ? 'bg-cyan-500/25 border-cyan-300/70 text-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.4)]'
                                    : m === 'line'
                                      ? 'bg-emerald-500/25 border-emerald-300/70 text-emerald-200 shadow-[0_0_8px_rgba(16,185,129,0.4)]'
                                      : 'bg-fuchsia-500/25 border-fuchsia-300/70 text-fuchsia-200 shadow-[0_0_8px_rgba(217,70,239,0.45)]'
                                  : 'bg-[#0A0F16] border-slate-700/80 text-slate-500 hover:text-slate-300'
                              } ${m === 'inst' ? 'italic' : ''}`}
                            >
                              {m === 'inst' ? 'INST' : spec.shortLabel}
                            </button>
                          );
                        })}
                      </div>

                      {/* 48V / PAD / Ø — hardware toggle row */}
                      <div className="grid grid-cols-3 gap-1">
                        <button
                          type="button"
                          disabled={stripDisabled || !modeSpec.phantomAllowed}
                          onClick={() => onUpdateChannel(ch.id, { phantom48v: !ch.phantom48v })}
                          title={
                            !modeSpec.phantomAllowed
                              ? chMode === 'inst'
                                ? '+48V LOCKED — never send phantom power into an instrument or unprotected DI (auto-disengaged)'
                                : '+48V unavailable on LINE jacks (mic domain only)'
                              : ch.phantom48v
                                ? '+48V Phantom ON — disengage'
                                : '+48V Phantom Power (condenser mics)'
                          }
                          className={`h-8 rounded border font-mono text-[10px] font-bold transition cursor-pointer disabled:cursor-not-allowed ${
                            ch.phantom48v && modeSpec.phantomAllowed
                              ? 'bg-rose-600 border-rose-300 text-white shadow-[0_0_8px_rgba(244,63,94,0.6)]'
                              : modeSpec.phantomAllowed
                                ? 'hw-top-btn text-slate-300'
                                : 'bg-[#0A0E14] border-[#1F2937] text-slate-700'
                          } ${stripDisabled ? 'opacity-45' : ''}`}
                        >
                          48V
                        </button>
                        <button
                          type="button"
                          disabled={stripDisabled}
                          onClick={() => onUpdateChannel(ch.id, { padDb: !ch.padDb })}
                          title={
                            ch.padDb
                              ? '−20 dB Pad IN — disengage'
                              : '−20 dB Pad — protect preamp from hot active pickups / line sources'
                          }
                          className={`h-8 rounded border font-mono text-[10px] font-bold transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                            ch.padDb
                              ? 'bg-amber-500 border-amber-200 text-slate-950 shadow-[0_0_8px_rgba(245,158,11,0.55)]'
                              : 'hw-top-btn text-slate-300'
                          }`}
                        >
                          PAD
                        </button>
                        <button
                          type="button"
                          disabled={stripDisabled}
                          onClick={() => onUpdateChannel(ch.id, { polarityInverted: !ch.polarityInverted })}
                          title={
                            ch.polarityInverted
                              ? 'Polarity Ø INVERTED (180°) — restore'
                              : 'Polarity Ø Invert (180°) — fix DI/cabinet phase issues'
                          }
                          className={`h-8 rounded border font-mono text-[11px] font-bold transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                            ch.polarityInverted
                              ? 'bg-sky-500 border-sky-300 text-slate-950 shadow-[0_0_8px_rgba(56,189,248,0.55)]'
                              : 'hw-top-btn text-slate-300'
                          }`}
                        >
                          Ø
                        </button>
                      </div>
                    </div>

                    {/* ==== Section 3: Preamp gain — full-size rotary ==== */}
                    <div
                      className={`rounded-md border p-2 flex items-center gap-3 shrink-0 ${
                        !isAssigned
                          ? 'border-[#232E3C] bg-[#0C1117]/70 opacity-80'
                          : 'border-[#4B5D72] bg-gradient-to-b from-[#1E2732] to-[#131921] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                      }`}
                    >
                      <RotaryKnob
                        label=""
                        value={isAssigned ? clampGainForMode(ch.gainDb, chMode) : modeSpec.unityGainDb}
                        min={modeSpec.gainMin}
                        max={modeSpec.gainMax}
                        step={1}
                        defaultValue={modeSpec.unityGainDb}
                        unit="dB"
                        size={68}
                        disabled={stripDisabled}
                        accent={!isAssigned ? 'slate' : isHot ? 'amber' : 'sky'}
                        formatValue={isAssigned ? modeSpec.formatGain : () => '--'}
                        onChange={(next) => onUpdateChannel(ch.id, { gainDb: next })}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400 truncate">
                            {chMode === 'line' ? 'Line Trim' : chMode === 'inst' ? 'Hi-Z Gain' : 'Mic Preamp'}
                          </span>
                          <span
                            className={`font-mono text-[7.5px] px-1 py-0.5 rounded border shrink-0 ${
                              chMode === 'inst'
                                ? 'text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-950/40'
                                : chMode === 'line'
                                  ? 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40'
                                  : 'text-cyan-300 border-cyan-500/40 bg-cyan-950/40'
                            }`}
                          >
                            {chMode === 'inst' ? 'INST 1MΩ' : chMode === 'line' ? 'LINE TRS' : 'MIC XLR'}
                          </span>
                        </div>
                        <div className="font-mono text-[19px] font-bold tabular-nums leading-none mt-1.5 text-slate-100">
                          {isAssigned ? modeSpec.formatGain(clampGainForMode(ch.gainDb, chMode)) : '--'}
                          <span className="text-[10px] text-slate-500 font-semibold ml-1">dB</span>
                        </div>
                        <div
                          className="font-mono text-[7.5px] text-slate-500 mt-1.5 truncate"
                          title={gainRangeNote}
                        >
                          {gainRangeNote}
                        </div>
                      </div>
                    </div>

                    {/* ==== Section 4: THE SUPER FADER — tall calibrated throw,
                          oversized cap, PPM tower and RMS/PEAK readouts ==== */}
                    <div
                      className={`rounded-md border p-2 flex flex-col gap-1 shrink-0 ${
                        !isAssigned
                          ? 'border-[#232E3C] bg-[#0C1117]/70 opacity-80'
                          : isHot
                            ? 'border-amber-400 bg-gradient-to-b from-[#241C12] to-[#171009] shadow-[0_0_12px_rgba(245,158,11,0.25)]'
                            : 'border-[#2DD4BF]/60 bg-gradient-to-b from-[#142328] to-[#0E181D] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]'
                      }`}
                    >
                      <div className="flex items-center justify-between px-0.5">
                        <span className="font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400">
                          Channel Fader
                        </span>
                        <span
                          className={`font-mono text-[15px] font-bold tabular-nums leading-none ${
                            !isAssigned
                              ? 'text-slate-600'
                              : ch.faderDb > 0.05
                                ? 'text-cyan-300'
                                : ch.faderDb < -0.05
                                  ? 'text-amber-400'
                                  : 'text-slate-200'
                          }`}
                        >
                          {!isAssigned ? '--' : ch.faderDb > 0 ? `+${ch.faderDb.toFixed(1)}` : ch.faderDb.toFixed(1)}
                          <span className="text-[9px] text-slate-500 font-semibold ml-0.5">dB</span>
                        </span>
                      </div>

                      <div className="flex items-start justify-between gap-2 px-0.5">
                        {/* Calibrated decibel scale */}
                        <div className="mt-10 h-[216px] 2xl:h-[252px] flex flex-col justify-between items-end font-mono text-[8px] text-slate-500 tabular-nums select-none pr-1 shrink-0">
                          <span className={isAssigned ? 'text-rose-400 font-semibold' : 'text-slate-600'}>+10</span>
                          <span>+5</span>
                          <span className={isAssigned ? 'text-slate-300 font-bold' : 'text-slate-600'}>0</span>
                          <span>−10</span>
                          <span>−20</span>
                          <span>−30</span>
                          <span>−40</span>
                          <span className="text-slate-600">−∞</span>
                        </div>

                        {/* The super fader itself */}
                        <PrecisionVerticalFader
                          value={isAssigned ? ch.faderDb : -48}
                          min={-48}
                          max={10}
                          step={0.5}
                          large
                          disabled={stripDisabled}
                          trackHeightClass="h-[216px] 2xl:h-[252px]"
                          accent={!isAssigned ? 'slate' : ch.mute ? 'amber' : 'cyan'}
                          onChange={(next) => onUpdateChannel(ch.id, { faderDb: next })}
                        />

                        {/* 10-segment console PPM tower */}
                        <div
                          className="mt-10 h-[216px] 2xl:h-[252px] w-4 rounded-[3px] bg-[#080C10] border border-slate-800/90 p-[2px] flex flex-col justify-between gap-[2px] shrink-0 overflow-hidden"
                          aria-label={`Channel ${ch.index} Level`}
                        >
                          {SEGMENTS_10.slice()
                            .reverse()
                            .map((segIdx) => {
                              const lit = isAssigned && !ch.mute && segIdx < litSegments;
                              const color =
                                segIdx >= 8
                                  ? lit
                                    ? isHot
                                      ? 'bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.9)]'
                                      : 'bg-rose-500 shadow-[0_0_5px_rgba(244,63,94,0.85)]'
                                    : 'bg-[#1D161A]'
                                  : segIdx >= 6
                                    ? lit
                                      ? 'bg-amber-400'
                                      : 'bg-[#1C1E1B]'
                                    : lit
                                      ? 'bg-[#4ADE80] shadow-[0_0_5px_rgba(74,222,128,0.65)]'
                                      : 'bg-[#101C18]';
                              return <div key={segIdx} className={`w-full flex-1 rounded-[1px] ${color}`} />;
                            })}
                        </div>

                        {/* RMS / PEAK telemetry column */}
                        <div className="mt-10 h-[216px] 2xl:h-[252px] flex flex-col justify-between items-end shrink-0 py-0.5">
                          <div className="text-right">
                            <div className="font-mono text-[7.5px] uppercase tracking-wider text-slate-500">RMS</div>
                            <div
                              className={`font-mono text-[11px] font-bold tabular-nums leading-tight ${
                                isAssigned && rmsDb > -18 ? 'text-emerald-300' : 'text-slate-300'
                              }`}
                            >
                              {isAssigned && !ch.mute ? fmtDb(rmsDb) : '--'}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono text-[7.5px] uppercase tracking-wider text-slate-500">PEAK</div>
                            <div
                              className={`font-mono text-[11px] font-bold tabular-nums leading-tight ${
                                isAssigned && peakDb > -2.5 ? 'text-rose-400' : 'text-slate-300'
                              }`}
                            >
                              {isAssigned && !ch.mute ? fmtDb(peakDb) : '--'}
                            </div>
                          </div>
                          <div className="text-right">
                            {isHot ? (
                              <span className="font-mono text-[9px] font-bold tracking-[0.18em] text-amber-400">
                                LIMIT
                              </span>
                            ) : ch.mute && isAssigned ? (
                              <span className="font-mono text-[9px] font-bold tracking-[0.18em] text-rose-400">
                                MUTED
                              </span>
                            ) : (
                              <span className="font-mono text-[8px] text-slate-600 tracking-[0.18em]">PPM</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* ==== Section 5: MUTE / SOLO — full-width finger-size keys ==== */}
                    <div className="grid grid-cols-2 gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={stripDisabled}
                        onClick={() => onUpdateChannel(ch.id, { mute: !ch.mute })}
                        title={
                          !isAssigned ? 'Open Slot — Unassigned' : ch.mute ? 'Unmute Channel' : 'Mute Channel'
                        }
                        className={`h-11 rounded-md border font-mono text-[11px] font-bold tracking-[0.18em] transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                          !isAssigned
                            ? 'bg-[#0A0E14] border-[#1F2937] text-slate-600'
                            : ch.mute
                              ? 'bg-rose-600 border-rose-300 text-white shadow-[0_0_10px_rgba(244,63,94,0.55)]'
                              : 'hw-top-btn text-slate-200'
                        }`}
                      >
                        MUTE
                      </button>
                      <button
                        type="button"
                        disabled={stripDisabled}
                        onClick={() => onUpdateChannel(ch.id, { solo: !ch.solo })}
                        title={
                          !isAssigned ? 'Open Slot — Unassigned' : ch.solo ? 'Clear Solo' : 'Solo Channel'
                        }
                        className={`h-11 rounded-md border font-mono text-[11px] font-bold tracking-[0.18em] transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                          !isAssigned
                            ? 'bg-[#0A0E14] border-[#1F2937] text-slate-600'
                            : ch.solo
                              ? 'bg-amber-400 border-amber-200 text-slate-950 shadow-[0_0_10px_rgba(245,158,11,0.55)]'
                              : 'hw-top-btn text-slate-200'
                        }`}
                      >
                        SOLO
                      </button>
                    </div>

                    {/* ==== Section 6: Mix bus assign keys ==== */}
                    <div className="flex flex-col gap-1 shrink-0">
                      <span className="px-1 font-mono text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        Mix Bus Assigns
                      </span>
                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          disabled={stripDisabled}
                          title={!isAssigned ? 'Open Slot — Unassigned' : 'Assign to Main PA Mix'}
                          onClick={() => onUpdateChannel(ch.id, { mainPaAssign: !isMainPaAssigned })}
                          className={`h-9 rounded-md border font-mono text-[9.5px] font-bold tracking-wider transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                            !isAssigned
                              ? 'bg-[#070A10] border-slate-800/80 text-slate-600'
                              : isMainPaAssigned
                                ? 'bg-emerald-500/25 border-emerald-400 text-emerald-200 shadow-[0_0_8px_rgba(16,185,129,0.35)]'
                                : 'bg-[#0A0F1A] border-slate-700/80 text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          MAIN PA
                        </button>
                        <button
                          type="button"
                          disabled={stripDisabled}
                          title={!isAssigned ? 'Open Slot — Unassigned' : 'Assign to Live Stream / OBS Mix'}
                          onClick={() => onUpdateChannel(ch.id, { streamAssign: !isStreamAssigned })}
                          className={`h-9 rounded-md border font-mono text-[9.5px] font-bold tracking-wider transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                            !isAssigned
                              ? 'bg-[#070A10] border-slate-800/80 text-slate-600'
                              : isStreamAssigned
                                ? 'bg-emerald-500/25 border-emerald-400 text-emerald-200 shadow-[0_0_8px_rgba(16,185,129,0.35)]'
                                : 'bg-[#0A0F1A] border-slate-700/80 text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          STREAM
                        </button>
                        <button
                          type="button"
                          disabled={stripDisabled}
                          title={!isAssigned ? 'Open Slot — Unassigned' : 'Assign to Subwoofer Bus'}
                          onClick={() => onUpdateChannel(ch.id, { subAssign: !isSubAssigned })}
                          className={`h-9 rounded-md border font-mono text-[9.5px] font-bold tracking-wider transition cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                            !isAssigned
                              ? 'bg-[#070A10] border-slate-800/80 text-slate-600'
                              : isSubAssigned
                                ? 'bg-fuchsia-500/25 border-fuchsia-400 text-fuchsia-200 shadow-[0_0_8px_rgba(217,70,239,0.4)]'
                                : 'bg-[#0A0F1A] border-slate-700/80 text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          SUB
                        </button>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex items-center justify-center p-3">
              <span className="font-mono text-[10px] text-slate-500">
                No input channels — press + to add a strip.
              </span>
            </div>
          )}

          {/* Collapsible Live Hardware Input Patch Tray (1-Click Route to Focused Channel) */}
          <div className="shrink-0 border-t border-[#445568] bg-[#10151B]">
            <div className="flex items-stretch">
              <button
                type="button"
                onClick={() => setPatchTrayOpen((v) => !v)}
                className="flex-1 min-w-0 px-2.5 py-1.5 hw-card-subheader flex items-center justify-between font-mono text-[9.5px] font-bold hover:text-white cursor-pointer"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <Cable className="w-3 h-3 text-teal-300 shrink-0" />
                  <span className="truncate">HARDWARE INPUTS ({inputDevices.length})</span>
                  {desktopAudioStatus?.supported && (
                    <span
                      className={`px-1 py-0.2 rounded text-[7.5px] border shrink-0 ${
                        singleSpeakerMode || desktopAudioStatus.apoActive
                          ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                          : 'bg-cyan-500/15 border-cyan-400/40 text-cyan-300'
                      }`}
                    >
                      {singleSpeakerMode || desktopAudioStatus.apoActive ? 'APO' : 'WASAPI'}
                    </span>
                  )}
                </span>
                {patchTrayOpen ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                ) : (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                )}
              </button>
              {/* LIVE RESCAN: Input Devices */}
              <button
                type="button"
                disabled={scanning}
                onClick={() => void handleScan()}
                title="Live Rescan All Input Devices (USB, soundcard & virtual cables incl. VB-Audio)"
                aria-label="Live rescan input devices"
                className="shrink-0 px-1.5 m-1 rounded hw-top-btn font-mono text-[8.5px] font-bold text-teal-200 flex items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <RefreshCw
                  className={`w-3 h-3 shrink-0 ${scanning ? 'animate-spin text-teal-300' : 'text-teal-300'}`}
                />
                <span className="hidden 2xl:inline">RESCAN</span>
              </button>
            </div>

            {patchTrayOpen && (
              <div className="max-h-[168px] overflow-y-auto px-1.5 py-1.5 space-y-1">
                {/* Labeled Live Input Rescan Row */}
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => void handleScan()}
                  title="Live Rescan All Input Devices (requests mic permission once to unlock device labels)"
                  aria-label="Live rescan input devices"
                  className={`w-full px-2 py-1 rounded border font-mono text-[8.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 transition ${
                    scanning
                      ? 'border-teal-400/70 bg-teal-950/50 text-teal-200'
                      : 'border-teal-500/45 bg-teal-950/35 hover:bg-teal-900/50 text-teal-200'
                  }`}
                >
                  <RefreshCw className={`w-2.5 h-2.5 shrink-0 ${scanning ? 'animate-spin' : ''}`} />
                  <span>{scanning ? 'RESCANNING INPUTS…' : `LIVE RESCAN INPUTS (${inputDevices.length} FOUND)`}</span>
                </button>
                {onActivateSystemAudioBridge && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={onActivateSystemAudioBridge}
                    title="Route browser tab, media player, or system audio via the isolated System Audio Input Bridge (zero loopback)"
                    className={`w-full px-2 py-1 rounded border font-mono text-[8.5px] font-bold flex items-center justify-between gap-1 cursor-pointer disabled:opacity-45 ${
                      audioSource === 'desktop-audio' && engineRunning
                        ? desktopBridgeState?.selfLoopbackBlocked
                          ? 'border-amber-400/75 bg-amber-950/45 text-amber-200'
                          : 'border-emerald-400/75 bg-emerald-950/45 text-emerald-200'
                        : 'border-cyan-500/45 bg-cyan-950/35 hover:bg-cyan-900/50 text-cyan-200'
                    }`}
                  >
                    <span className="flex items-center gap-1 min-w-0 truncate">
                      <Radio className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">
                        {audioSource === 'desktop-audio' && engineRunning
                          ? 'Desktop Audio Bridge ON'
                          : 'System Audio Bridge'}
                      </span>
                    </span>
                    <span className="text-[7.5px] opacity-85 shrink-0">
                      {audioSource === 'desktop-audio' && engineRunning
                        ? desktopBridgeState?.selfLoopbackBlocked
                          ? 'SAFEWALL'
                          : 'ISOLATED'
                        : specializedDesktopInputs.length > 0
                          ? `${specializedDesktopInputs.length} VIRT`
                          : 'TAB/OS'}
                    </span>
                  </button>
                )}
                {desktopAudioStatus?.supported && onEnableBrowserDspSpeakers && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={onEnableBrowserDspSpeakers}
                    title="Route Browser Audio through DSP to Built-In Speakers and mute built-in microphone to prevent acoustic loopback"
                    className="w-full px-2 py-1 rounded border border-cyan-500/45 bg-cyan-950/35 hover:bg-cyan-900/50 text-cyan-200 font-mono text-[8.5px] font-bold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-45"
                  >
                    <Speaker className="w-2.5 h-2.5 shrink-0 text-cyan-300" />
                    <span className="truncate">Browser → Built-In Speakers (Mute Mic + DSP)</span>
                  </button>
                )}
                {inputDevices.length === 0 ? (
                  <div className="p-2 rounded border border-dashed border-[#344355] bg-[#0B1015] text-center font-mono text-[9px] text-slate-500">
                    No inputs detected. Click refresh to scan USB / soundcard inputs.
                  </div>
                ) : (
                  inputDevices.map((dev, idx) => {
                    const cls = classifyInput(dev.label || '');
                    const label = dev.label || `Audio Input ${idx + 1}`;
                    const slottedChannel = channels.find((c) => c.hardwareInputId === dev.deviceId);
                    const boundToSelected = selectedChannel?.hardwareInputId === dev.deviceId;
                    return (
                      <div
                        key={`patch-in-${dev.deviceId}-${idx}`}
                        className={`px-2 py-1 rounded border flex items-center justify-between gap-1.5 font-mono text-[9px] ${
                          boundToSelected
                            ? 'border-teal-400/75 bg-[#122226]'
                            : slottedChannel
                              ? 'border-emerald-500/45 bg-[#0F1B18]'
                              : 'border-[#3C4B5E] bg-[#0E141C]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls.dot}`} />
                          <span className="truncate text-slate-200" title={label}>
                            {label}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {slottedChannel && !boundToSelected && (
                            <button
                              type="button"
                              onClick={() => onSelectChannel(slottedChannel.id)}
                              title={`Focus CH${slottedChannel.index} (${slottedChannel.name})`}
                              className="px-1 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-[8px] font-bold cursor-pointer"
                            >
                              CH{slottedChannel.index}
                            </button>
                          )}
                          {selectedChannel && (
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() => {
                                const auto = deriveAutoChannelNameAndRole(label, selectedChannel.index);
                                onUpdateChannel(selectedChannel.id, {
                                  hardwareInputId: dev.deviceId,
                                  hardwareInputLabel: label,
                                  name: auto.name,
                                  role: auto.role,
                                });
                              }}
                              title={
                                boundToSelected
                                  ? `Active on CH${selectedChannel.index}`
                                  : `Move/Assign "${label}" to CH${selectedChannel.index} (${selectedChannel.name}) 1:1`
                              }
                              className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold shrink-0 flex items-center gap-0.5 cursor-pointer disabled:opacity-45 ${
                                boundToSelected
                                  ? 'bg-teal-500 text-slate-950 border border-teal-300'
                                  : 'hw-top-btn text-teal-200'
                              }`}
                            >
                              <span>{boundToSelected ? `✓ CH${selectedChannel.index}` : `→ CH${selectedChannel.index}`}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}

                {desktopAudioSessions.length > 0 && (
                  <div className="pt-1 mt-1 border-t border-[#263242] space-y-1">
                    <div className="px-1 font-mono text-[8px] font-bold uppercase tracking-wider text-cyan-400/90">
                      Open Apps (Per-App Capture)
                    </div>
                    {desktopAudioSessions.map((sess) => {
                      const appDevId = `${NATIVE_APP_AUDIO_PREFIX}${sess.pid}`;
                      const appLabel = `App: ${sess.name}`;
                      const slottedChannel = channels.find((c) => c.hardwareInputId === appDevId);
                      const boundToSelected = selectedChannel?.hardwareInputId === appDevId;
                      return (
                        <div
                          key={`app-sess-${sess.pid}`}
                          className={`px-2 py-1 rounded border flex items-center justify-between gap-1.5 font-mono text-[9px] ${
                            boundToSelected
                              ? 'border-cyan-400/75 bg-[#0D2129]'
                              : slottedChannel
                                ? 'border-emerald-500/45 bg-[#0F1B18]'
                                : 'border-[#2E3C4F] bg-[#0B1118]'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                sess.state === 'active' ? 'bg-cyan-400' : 'bg-slate-500'
                              }`}
                            />
                            <span className="truncate text-slate-200" title={`${sess.name} (PID ${sess.pid})`}>
                              {sess.name}
                            </span>
                          </div>
                          {selectedChannel && (
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() => {
                                onUpdateChannel(selectedChannel.id, {
                                  hardwareInputId: appDevId,
                                  hardwareInputLabel: appLabel,
                                  name: sess.name.slice(0, 18),
                                  role: 'App Audio',
                                });
                              }}
                              className={`px-1.5 py-0.5 rounded text-[8.5px] font-bold shrink-0 cursor-pointer disabled:opacity-45 ${
                                boundToSelected
                                  ? 'bg-cyan-500 text-slate-950 border border-cyan-300'
                                  : 'hw-top-btn text-cyan-200'
                              }`}
                            >
                              {boundToSelected ? `✓ CH${selectedChannel.index}` : `→ CH${selectedChannel.index}`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 2: LIVE OUTPUT DESTINATIONS & DISCRETE PCIE JACK ASSIGNMENTS
          ========================================================================= */}
      {activeTab === 'outputs' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1.5">
            {/* ==== DISCRETE JACK BAY — 5.1/7.1 cards exploded into per-jack
                      zone routing (one zone per physical jack pair) ==== */}
            {outputJackEndpoints.length > 0 &&
              (() => {
                const byDevice = new Map<string, OutputJackEndpoint[]>();
                for (const jack of outputJackEndpoints) {
                  const list = byDevice.get(jack.parentDeviceId) ?? [];
                  list.push(jack);
                  byDevice.set(jack.parentDeviceId, list);
                }
                return Array.from(byDevice.entries()).map(([deviceId, deviceJacks]) => {
                  const ordered = OUTPUT_JACK_SLOT_ORDER.map((slot) =>
                    deviceJacks.find((j) => j.slot === slot)
                  ).filter((j): j is OutputJackEndpoint => Boolean(j));
                  const first = ordered[0];
                  const isSink = preferredOutputDeviceId === deviceId;
                  const autoPatches = onUpdateZone ? buildAutoJackAssignments(zones, ordered) : [];
                  return (
                    <div
                      key={`jackbay-${deviceId}`}
                      className={`rounded-md border p-1.5 space-y-1.5 ${
                        isSink
                          ? 'border-teal-400/80 bg-gradient-to-b from-[#142328] to-[#0E181D] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_10px_rgba(45,212,191,0.22)]'
                          : 'border-[#4B5D72] bg-gradient-to-b from-[#1E2732] to-[#131921]'
                      }`}
                    >
                      {/* Bay header */}
                      <div className="flex items-center justify-between gap-1 px-0.5">
                        <span className="flex items-center gap-1 min-w-0">
                          <span className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-teal-300 shrink-0">
                            Discrete Jack Bay
                          </span>
                          <span
                            className={`px-1 py-0.5 rounded border font-mono text-[7.5px] font-bold shrink-0 ${
                              first.layout === '7.1'
                                ? 'text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-950/40'
                                : 'text-cyan-300 border-cyan-500/40 bg-cyan-950/40'
                            }`}
                            title={`${first.channelCount}-channel endpoint — discrete per-jack routing available`}
                          >
                            {first.layout}
                          </span>
                          {first.simulated && (
                            <span
                              className="px-1 py-0.5 rounded border font-mono text-[7px] font-bold text-amber-300 border-amber-500/40 bg-amber-950/40 shrink-0"
                              title="Training card — no physical hardware behind it; jack routing logic is identical to a real 7.1 card"
                            >
                              SIM
                            </span>
                          )}
                          {isSink && (
                            <span className="px-1 py-0.5 rounded border font-mono text-[7px] font-bold text-emerald-300 border-emerald-500/40 bg-emerald-950/40 shrink-0">
                              ACTIVE SINK
                            </span>
                          )}
                        </span>
                        <span
                          className="font-mono text-[7.5px] text-slate-500 truncate"
                          title={first.parentDeviceLabel}
                        >
                          {first.parentDeviceLabel}
                        </span>
                      </div>

                      {/* One row per physical jack pair */}
                      {ordered.map((jack) => {
                        const zoneOnJack = zones.find((z) => z.outputJackId === jack.jackId);
                        const jackRms = fastJackRms[jack.slot] ?? -96;
                        const meterPct = Math.max(0, Math.min(100, ((jackRms + 54) / 54) * 100));
                        const meterColor =
                          meterPct > 92
                            ? 'bg-rose-500'
                            : meterPct > 80
                              ? 'bg-amber-400'
                              : 'bg-emerald-400';
                        return (
                          <div
                            key={jack.jackId}
                            className={`flex items-center gap-1.5 px-1 py-1 rounded border ${
                              zoneOnJack
                                ? 'border-[#3A4B5E] bg-[#0F151D]'
                                : 'border-dashed border-[#2A3544] bg-[#0C1117]/60'
                            }`}
                          >
                            <span
                              className="w-3 h-3 rounded-[2px] border border-white/25 shrink-0"
                              style={{ backgroundColor: jack.jackColorHex }}
                              title={`${jack.jackColorName} jack (industry HD Audio colour code)`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="font-mono text-[9px] font-bold text-slate-200 leading-none truncate">
                                {jack.label}
                              </div>
                              <div className="font-mono text-[7px] text-slate-500 leading-none mt-1">
                                CH {jack.channelIndices[0]}/{jack.channelIndices[1]} · {jack.jackColorName} jack
                              </div>
                            </div>
                            {/* live jack meter */}
                            <div
                              className="w-8 h-1.5 rounded-sm bg-[#090D12] border border-[#2C394A] overflow-hidden shrink-0"
                              aria-label={`${jack.label} jack level`}
                            >
                              <div
                                className={`h-full ${meterColor} transition-all duration-100`}
                                style={{ width: `${meterPct}%` }}
                              />
                            </div>
                            {onUpdateZone ? (
                              <select
                                aria-label={`${jack.label} jack zone assignment`}
                                value={zoneOnJack?.id ?? ''}
                                disabled={locked}
                                onChange={(e) => {
                                  const nextZoneId = e.target.value;
                                  // Conflict-free swap: clear whatever zone
                                  // currently occupies this jack, then land the
                                  // chosen zone on it (one zone per jack).
                                  if (zoneOnJack && zoneOnJack.id !== nextZoneId) {
                                    onUpdateZone(zoneOnJack.id, { outputJackId: undefined });
                                  }
                                  if (nextZoneId) {
                                    onUpdateZone(nextZoneId, { outputJackId: jack.jackId });
                                  }
                                }}
                                title={`Assign a speaker zone to the ${jack.jackColorName} ${jack.label} jack — one zone per jack (selecting swaps automatically)`}
                                className="w-[86px] h-6 px-1 rounded border border-[#293544] bg-[#0B1017] text-slate-200 text-[8.5px] cursor-pointer disabled:opacity-45 shrink-0"
                              >
                                <option value="">— open jack —</option>
                                {zones.map((z) => (
                                  <option key={z.id} value={z.id}>
                                    {z.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="font-mono text-[8px] text-slate-500 shrink-0">
                                {zoneOnJack ? zoneOnJack.name : 'open'}
                              </span>
                            )}
                          </div>
                        );
                      })}

                      {/* Bay footer: auto-assign, sink activation, Windows config */}
                      <div className="flex items-center gap-1">
                        {onUpdateZone && autoPatches.length > 0 && (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => {
                              for (const p of autoPatches) onUpdateZone(p.zoneId, p.patch);
                            }}
                            title="Church-install auto patch: Main PA → FRONT (green), Sub → CENTER/SUB (orange), Overflow/Rear-fill → REAR (black), Stage monitor → SIDE (grey)"
                            className="flex-1 h-6 rounded border border-teal-500/45 bg-teal-950/35 hover:bg-teal-900/50 text-teal-200 font-mono text-[8px] font-bold cursor-pointer disabled:opacity-45"
                          >
                            AUTO-ASSIGN ZONES
                          </button>
                        )}
                        {!isSink && onSelectOutputDevice && (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => onSelectOutputDevice(deviceId)}
                            title="Make this multi-channel card the Master PA sink — its jacks then carry the zone patch above"
                            className="flex-1 h-6 rounded border border-emerald-500/45 bg-emerald-950/35 hover:bg-emerald-900/50 text-emerald-200 font-mono text-[8px] font-bold cursor-pointer disabled:opacity-45"
                          >
                            SET AS MASTER PA
                          </button>
                        )}
                      </div>
                      <p className="font-mono text-[7px] leading-relaxed text-slate-500 px-0.5">
                        {jackRouterStatus} · Windows speaker configuration for this device must be set to{' '}
                        {first.layout} (Sound Control Panel) for 1:1 per-jack routing.
                      </p>
                    </div>
                  );
                });
              })()}

            {/* Jack probe / training-card controls */}
            <div className="flex items-center gap-1">
              {onProbeJacks && outputDevices.length > 0 && (
                <button
                  type="button"
                  disabled={jackProbeBusy}
                  onClick={() => onProbeJacks()}
                  title="Probe every output endpoint for a 5.1/7.1 multichannel layout and expose its discrete jack pairs"
                  className="flex-1 h-7 rounded border border-cyan-500/45 bg-cyan-950/35 hover:bg-cyan-900/50 text-cyan-200 font-mono text-[8.5px] font-bold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-45"
                >
                  {jackProbeBusy ? 'PROBING JACKS…' : 'PROBE DISCRETE JACKS'}
                </button>
              )}
              {onToggleSimulatedSurroundCard && (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onToggleSimulatedSurroundCard()}
                  title="Training mode: add a simulated 7.1 PCIe jack card (green/black/orange/grey pairs) to rehearse discrete jack routing without hardware"
                  className={`flex-1 h-7 rounded border font-mono text-[8.5px] font-bold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-45 ${
                    simulatedSurroundCard
                      ? 'border-amber-400 bg-amber-950/45 text-amber-200'
                      : 'border-[#293544] bg-[#0B1017] text-slate-400 hover:text-white'
                  }`}
                >
                  {simulatedSurroundCard ? 'SIM 7.1 CARD ON' : 'SIM 7.1 CARD'}
                </button>
              )}
              {isDesktopApp() && (
                <button
                  type="button"
                  onClick={() => void openWindowsSoundSettings()}
                  title="Open Windows Sound settings — set the card's speaker configuration to 5.1/7.1 so every jack carries its own pair"
                  className="h-7 px-1.5 rounded border border-[#293544] bg-[#0B1017] text-slate-400 hover:text-white font-mono text-[8.5px] font-bold cursor-pointer shrink-0"
                >
                  WIN SOUND
                </button>
              )}
            </div>

            {outputDevices.length === 0 ? (
              <div className="p-3 rounded border border-dashed border-[#344355] bg-[#0B1015] text-center font-mono text-[10px] text-slate-500">
                No audio output endpoints detected. Click refresh or plug in speakers/headphones.
              </div>
            ) : (
              outputDevices.map((dev, idx) => {
                const { kind, color, icon: DeviceIcon } = classifyOutput(dev.label || '');
                const isMasterOut = preferredOutputDeviceId
                  ? dev.deviceId === preferredOutputDeviceId
                  : idx === 0;
                const isStreamOut = dev.deviceId === preferredStreamOutputDeviceId;
                const assignedZones = zones.filter((z) => z.hardwareOutputId === dev.deviceId);
                const devLabel = dev.label || `Audio Output ${idx + 1}`;

                return (
                  <div
                    key={`out-card-${dev.deviceId}-${idx}`}
                    className={`p-2 rounded-md border space-y-1.5 transition ${
                      isMasterOut
                        ? 'border-emerald-400/80 bg-gradient-to-b from-[#13241F] to-[#0E1916] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]'
                        : isStreamOut
                          ? 'border-violet-400/80 bg-gradient-to-b from-[#1C1628] to-[#13101B] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]'
                          : 'border-[#4B5D72] bg-gradient-to-b from-[#1D2631] to-[#131921] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:border-[#687F99]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={`text-[8.5px] font-mono font-bold px-1.5 py-0.5 rounded border flex items-center gap-1 ${color}`}
                      >
                        <DeviceIcon className="w-2.5 h-2.5" />
                        <span>{kind}</span>
                      </span>
                      <span className="font-mono text-[8.5px] text-emerald-400 font-semibold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        LIVE
                      </span>
                    </div>

                    <div className="font-mono text-[10.5px] font-bold text-white truncate" title={devLabel}>
                      {devLabel}
                    </div>

                    <div className="flex items-center gap-1 flex-wrap font-mono text-[8.5px]">
                      {isMasterOut && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold flex items-center gap-0.5">
                          <Check className="w-2.5 h-2.5" /> Master PA
                        </span>
                      )}
                      {isStreamOut && (
                        <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/40 font-bold flex items-center gap-0.5">
                          <Radio className="w-2.5 h-2.5" /> Stream OBS
                        </span>
                      )}
                      {assignedZones.map((z) => (
                        <span
                          key={z.id}
                          className="px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300 border border-teal-500/35 truncate max-w-[120px]"
                        >
                          {z.name}
                        </span>
                      ))}
                      {!isMasterOut && !isStreamOut && assignedZones.length === 0 && (
                        <span className="text-slate-500 italic">Available port</span>
                      )}
                    </div>

                    {(isMasterOut || isStreamOut) && (
                      <div className="space-y-0.5 pt-0.5">
                        <div className="flex justify-between text-[8px] font-mono text-slate-400">
                          <span>BUS LEVEL</span>
                          <span className="text-emerald-400 font-bold tabular-nums">
                            {engineRunning ? `${fastPostDb.toFixed(1)} dBFS` : 'IDLE'}
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-[#090D12] border border-[#2C394A] overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-[#4ADE80] via-amber-400 to-rose-500 transition-all duration-75"
                            style={{ width: `${meterWidth}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-1 pt-0.5">
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => onSelectOutputDevice(dev.deviceId)}
                        className={`py-1 rounded font-mono text-[8.5px] font-bold cursor-pointer disabled:opacity-45 ${
                          isMasterOut
                            ? 'bg-emerald-600 text-white border border-emerald-300'
                            : 'hw-top-btn'
                        }`}
                      >
                        {isMasterOut ? '✓ Master PA' : 'Set Master PA'}
                      </button>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => onSelectStreamOutputDevice(isStreamOut ? '' : dev.deviceId)}
                        className={`py-1 rounded font-mono text-[8.5px] font-bold cursor-pointer disabled:opacity-45 ${
                          isStreamOut
                            ? 'bg-violet-600 text-white border border-violet-300'
                            : 'hw-top-btn'
                        }`}
                      >
                        {isStreamOut ? '✓ Stream OBS' : 'Set Stream OBS'}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* LIVE RESCAN: Output Devices */}
          <div className="shrink-0 border-t border-[#445568] bg-[#10151B] p-1.5 space-y-1.5">
            <button
              type="button"
              disabled={scanning}
              onClick={() => void handleScan()}
              title="Live Rescan All Output Devices (speakers, headphones, USB & virtual cable sinks)"
              aria-label="Live rescan output devices"
              className={`w-full py-1.5 rounded border font-mono text-[9.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 transition ${
                scanning
                  ? 'border-emerald-400/70 bg-emerald-950/50 text-emerald-200'
                  : 'border-emerald-500/45 bg-emerald-950/35 hover:bg-emerald-900/50 text-emerald-200'
              }`}
            >
              <RefreshCw className={`w-3 h-3 shrink-0 ${scanning ? 'animate-spin' : ''}`} />
              <span>
                {scanning
                  ? 'RESCANNING OUTPUTS…'
                  : `LIVE RESCAN OUTPUTS (${outputDevices.length} FOUND)`}
              </span>
            </button>
            <div className="px-1 font-mono text-[9px] text-slate-300 flex items-center justify-between">
              <span>Standalone Outputs</span>
              <span className="text-emerald-400 font-bold">STEREO 1:1</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

