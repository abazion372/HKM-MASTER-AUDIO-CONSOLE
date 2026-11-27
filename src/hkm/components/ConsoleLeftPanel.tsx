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
  VolumeX,
} from 'lucide-react';
import type {
  AudioSourceSimulation,
  InputChannel,
  SpeakerZone,
  SignalTelemetry,
} from '../types/audio.ts';
import { liveAudioEngine } from '../audio/liveAudioEngine.ts';
import { INPUT_MODES, getInputMode } from '../utils/inputMode.ts';
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
  type OutputJackEndpoint,
  type OutputJackSlot,
} from '../utils/jackTopology.ts';
import { isDesktopApp } from '../utils/appApi.ts';
import { openWindowsSoundSettings } from '../utils/nativeDesktopAudio.ts';
import { ChannelFxRackPanel } from './ChannelFxRack.tsx';
import type { ChannelFxRackState } from '../types/audio.ts';

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
  /** Guitar FX rack (pedalboard) updates for the selected channel. */
  onUpdateChannelFx?: (id: string, updater: (rack: ChannelFxRackState) => ChannelFxRackState) => void;
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

const fmtDb = (v: number) => (v <= -60 ? '−∞' : v.toFixed(1));

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
  onUpdateChannelFx,
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
  const [patchTrayOpen, setPatchTrayOpen] = useState(false);
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
      if (document.hidden) return;
      const st = liveAudioEngine.getJackRoutingStatus();
      setJackRouterStatus(
        st.active
          ? `ROUTER ACTIVE · ${st.channelCount}ch · ${st.slots.length} jack${st.slots.length === 1 ? '' : 's'} driven${st.simulated ? ' · SIM' : ''}`
          : 'ROUTER STANDBY (legacy stereo)'
      );
    }, 600);
    return () => window.clearInterval(t);
  }, [activeTab]);

  // v2 native per-jack WASAPI engine (desktop app only): shared vs exclusive
  // share-mode, armed with the active sink's channel layout.
  const [nativeJackEngineMode, setNativeJackEngineMode] = useState<'shared' | 'exclusive'>('shared');
  const [nativeJackEngineBusy, setNativeJackEngineBusy] = useState(false);
  const [nativeJackEngineNote, setNativeJackEngineNote] = useState<string | null>(null);
  const [nativeEngineStatus, setNativeEngineStatus] = useState('OFF');
  useEffect(() => {
    if (activeTab !== 'outputs') return;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      const st = liveAudioEngine.getRawOutputEngineStatus();
      if (!st.active) {
        setNativeEngineStatus('OFF');
        return;
      }
      setNativeEngineStatus(
        `${st.exclusive ? 'EXCLUSIVE' : 'SHARED'} · ${st.channels}CH · ${
          st.feed === 'jack' ? 'PER-JACK FEED' : 'MASTER STEREO FEED'
        }`
      );
    }, 600);
    return () => window.clearInterval(t);
  }, [activeTab]);

  const handleToggleNativeJackEngine = async (
    enabled: boolean,
    endpointId: string,
    channels: number
  ) => {
    if (!isDesktopApp()) return;
    setNativeJackEngineBusy(true);
    setNativeJackEngineNote(null);
    try {
      const ok = await liveAudioEngine.setRawOutputEnabled(enabled, endpointId, {
        channels: enabled ? channels : undefined,
        exclusive: enabled ? nativeJackEngineMode === 'exclusive' : undefined,
      });
      setNativeJackEngineNote(
        ok
          ? enabled
            ? `Native WASAPI engine armed (${nativeJackEngineMode.toUpperCase()} · ${channels}ch) — per-jack channels render through the native stream.`
            : 'Native engine disarmed — Web Audio output restored.'
          : 'Native engine could not be armed on this endpoint (device busy, exclusive conflict, or unsupported format).'
      );
    } finally {
      setNativeJackEngineBusy(false);
    }
  };

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
      className="w-[228px] 2xl:w-[256px] shrink-0 h-full hw-panel rounded-lg flex flex-col overflow-hidden select-none"
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
          TAB 1: INPUT CHANNEL BAY — CHANNEL TABS + ALL-INPUTS LIVE OVERVIEW
          Per-channel editing lives exactly once, in the central panel's
          INPUT CONDITIONING card (selected channel). This bay gives the
          whole input bank at a glance + click-to-focus (X32 channel-bay
          routing view style).
          ========================================================================= */}
      {activeTab === 'inputs' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* NOTE: the old channel tab rail (one numbered tab per input) was
              removed in the reference-console redesign — the Input Bay rows
              below are the single focus surface (click a row to load that
              channel into the central INPUT CONDITIONING card, X32-style). */}
          {/* ---- SELECTED CHANNEL BAY ----
              The old duplicated control strip (input source, preamp, fader,
              48V/PAD/Ø, mute/solo, bus assigns) now lives exactly once, in
              the central panel INPUT CONDITIONING card. This panel instead
              shows the full input bank at a glance — one live row per
              channel: meters, source, mode, gain/fader status and bus
              assigns — plus quick per-row mute/solo, and click-to-focus. */}
          {selectedChannel ? (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
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
                return (
                  <>
                    {/* ==== Selected channel identity header — anchors the bay ==== */}
                    <div
                      className={`mx-1.5 mt-1.5 rounded-md border p-2 flex items-center gap-2.5 shrink-0 transition-all ${
                        !isAssigned
                          ? 'border-dashed border-[#3A4B5E] bg-[#0F151D]/80'
                          : isHot
                            ? 'border-amber-400 bg-gradient-to-b from-[#2A2015] to-[#1A130D] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_10px_rgba(245,158,11,0.3)]'
                            : ch.mute
                              ? 'border-rose-500/60 bg-gradient-to-b from-[#2A1518] to-[#160D0F] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_10px_rgba(244,63,94,0.22)]'
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
                        {isAssigned ? (
                          <div
                            className="font-mono text-[8.5px] text-slate-400 truncate leading-tight mt-1"
                            title={`${ch.role} · ${ch.hardwareInputLabel || 'Engine Bridge'}`}
                          >
                            {ch.role} · {ch.hardwareInputLabel || (isBridgeSlot ? 'Engine Bridge' : ch.role)}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPatchTrayOpen(true)}
                            title="Open Slot — tap to assign a hardware input (opens the patch tray below)"
                            className="mt-1 flex items-center gap-1.5 font-mono text-[8.5px] font-bold tracking-wider text-cyan-300 hover:text-cyan-200 leading-tight cursor-pointer"
                          >
                            <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
                            OPEN SLOT · PATCH
                          </button>
                        )}
                      </div>
                      {!isAssigned ? (
                        <span className="w-2 h-2 rounded-full bg-[#1B232E] shrink-0" />
                      ) : isHot ? (
                        <AlertTriangle
                          className="w-4 h-4 text-amber-400 animate-pulse shrink-0"
                          aria-label="Signal hot — near limit"
                        />
                      ) : ch.mute ? (
                        <VolumeX
                          className="w-4 h-4 text-rose-400 shrink-0 animate-pulse"
                          aria-label="Channel muted"
                        />
                      ) : (
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            engineRunning && rmsDb > -52
                              ? 'bg-[#4ADE80] shadow-[0_0_6px_rgba(74,222,128,0.85)]'
                              : 'bg-slate-600'
                          }`}
                        />
                      )}
                    </div>
                  </>
                );
              })()}

              {/* ==== CHANNEL BAY — all-inputs live overview. The old strip's
                  freed space now shows the whole input bank at once: live
                  meter + source + mode + gain/fader + bus-assign status per
                  channel, quick per-row MUTE/SOLO, click a row to focus that
                  channel on the central console. ==== */}
              <div className="flex-1 min-h-[110px] flex flex-col px-1.5 pt-1.5">
                <div className="flex items-center justify-between px-0.5 pb-1 font-mono text-[8px] font-bold uppercase tracking-[0.16em] hw-engraved shrink-0">
                  <span>Input Bay</span>
                  <span
                    className="text-slate-400 tabular-nums normal-case tracking-normal flex items-center gap-1"
                    title="Live (assigned and unmuted) inputs / total input strips"
                  >
                    <span
                      aria-hidden="true"
                      className={`w-1.5 h-1.5 rounded-full ${
                        channels.some(
                          (c) =>
                            !c.mute &&
                            (Boolean(c.hardwareInputId) ||
                              (c.index === 1 &&
                                (audioSource === 'desktop-audio' || audioSource === 'pink-noise')))
                        )
                          ? 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.8)]'
                          : 'bg-slate-600'
                      }`}
                    />
                    {channels.filter(
                      (c) =>
                        !c.mute &&
                        (Boolean(c.hardwareInputId) ||
                          (c.index === 1 && (audioSource === 'desktop-audio' || audioSource === 'pink-noise')))
                    ).length}
                    /{channels.length}
                  </span>
                </div>
                <div
                  className="flex-1 min-h-0 overflow-y-auto pr-0.5 flex flex-col gap-1"
                  aria-label="All input channels overview"
                >
                  {channels.map((ch, i) => {
                    const bridge =
                      ch.index === 1 && (audioSource === 'desktop-audio' || audioSource === 'pink-noise');
                    const assigned = Boolean(ch.hardwareInputId) || bridge;
                    const isSelected = ch.id === selectedChannel.id;
                    const rDb =
                      assigned && engineRunning && !ch.mute
                        ? fastChRms[i] ?? telemetry.channelLevels?.[i]?.rmsDb ?? -96
                        : -96;
                    const pDb =
                      assigned && engineRunning && !ch.mute
                        ? fastChPeak[i] ?? telemetry.channelLevels?.[i]?.peakDb ?? -96
                        : -96;
                    const rNorm = Math.max(0, Math.min(1, (rDb + 54) / 54));
                    const pNorm = Math.max(0, Math.min(1, (pDb + 54) / 54));
                    const rowHot = assigned && pDb > -2.5;
                    const mode = getInputMode(ch);
                    const mSpec = INPUT_MODES[mode];
                    const sourceLabel = ch.hardwareInputLabel || (bridge ? 'Engine Bridge' : 'Open Slot');
                    const paOn = ch.mainPaAssign ?? true;
                    const stOn = ch.streamAssign ?? true;
                    const sbOn = ch.subAssign ?? false;
                    return (
                      <div
                        key={ch.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSelected}
                        onClick={() => onSelectChannel(ch.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectChannel(ch.id);
                          }
                        }}
                        title={`Focus CH${ch.index} — ${ch.name}${assigned ? ` (${sourceLabel})` : ' · Open Slot'} · full input strip loads in the central INPUT CONDITIONING card`}
                        className={`group rounded-md border p-1.5 flex items-center gap-2 cursor-pointer transition-all ${
                          isSelected
                            ? 'border-teal-300 bg-[#17282D] ring-1 ring-[#2DD4BF]/45 shadow-[0_0_8px_rgba(45,212,191,0.3)]'
                            : assigned
                              ? rowHot
                                ? 'border-amber-400/80 bg-gradient-to-b from-[#2A2015] to-[#161009]'
                                : ch.mute
                                  ? 'border-rose-500/60 bg-gradient-to-b from-[#2A1518] to-[#160D0F]'
                                  : 'border-[#4B5D72] bg-gradient-to-b from-[#1E2732] to-[#131921] hover:border-[#687F99]'
                              : 'border-dashed border-[#2A3544] bg-[#0D1219]/70'
                        }`}
                      >
                        {/* channel number badge — reference scribble strip:
                            number + solo/mute state LEDs under it */}
                        <div
                          className={`w-7 self-stretch rounded flex flex-col items-center justify-center gap-1 shrink-0 font-mono border ${
                            !assigned
                              ? 'border-[#222C39] bg-[#0B1017] text-slate-600'
                              : ch.mute
                                ? 'border-rose-500/50 bg-[#1A0E12] text-rose-300'
                                : isSelected
                                  ? 'border-teal-300/50 bg-[#0E2A2E] text-[#5EEAD4]'
                                  : 'border-[#2E3A4A] bg-[#0C1218] text-slate-300'
                          }`}
                          aria-label={`Channel ${ch.index}`}
                        >
                          <span className="text-[13px] font-bold leading-none">{ch.index}</span>
                          <span className="flex items-center gap-[3px] h-[5px]">
                            {ch.solo && assigned && (
                              <span
                                title="Solo engaged"
                                className="w-[5px] h-[5px] rounded-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.9)]"
                              />
                            )}
                            {ch.mute && assigned && (
                              <span
                                title="Muted"
                                className="w-[5px] h-[5px] rounded-full bg-rose-500 shadow-[0_0_4px_rgba(244,63,94,0.9)]"
                              />
                            )}
                          </span>
                        </div>

                        {/* name + live RMS readout + twin vertical segmented LED meters */}
                        <div className="flex-1 min-w-0 flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-1.5 min-w-0">
                            <span
                              className={`text-[10px] font-semibold truncate leading-none ${
                                !assigned ? 'text-slate-500' : ch.mute ? 'text-rose-200' : 'text-slate-200'
                              }`}
                              title={`CH${ch.index} — ${ch.name}${assigned ? ` · ${sourceLabel}` : ' · Open Slot'}`}
                            >
                              {ch.name}
                            </span>
                            <span
                              className={`font-mono text-[7px] tabular-nums shrink-0 leading-none ${
                                !assigned
                                  ? 'text-slate-600'
                                  : ch.mute
                                    ? 'text-rose-400'
                                    : rowHot
                                      ? 'text-rose-300'
                                      : rDb > -18
                                        ? 'text-emerald-300'
                                        : 'text-slate-400'
                              }`}
                            >
                              {!assigned ? '--' : ch.mute ? 'MUTE' : fmtDb(rDb)}
                            </span>
                          </div>
                          <div className="flex items-stretch gap-[3px] h-[32px]">
                            {/* RMS column — hardware convention: fills upward from the bottom (green low → red clip at top) */}
                            <div
                              className="hw-led-track !flex-col-reverse w-[9px]"
                              role="meter"
                              aria-label={`Channel ${ch.index} RMS level meter`}
                              aria-valuenow={Math.round(rNorm * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              {Array.from({ length: 8 }).map((_, seg) => {
                                const lit = assigned && !ch.mute && rNorm >= (seg + 1) / 8 - 0.999 / 8;
                                const color = seg >= 7 ? 'red' : seg >= 6 ? 'amber' : 'green';
                                return (
                                  <span
                                    key={seg}
                                    className="hw-led-seg"
                                    data-lit={lit ? color : undefined}
                                  />
                                );
                              })}
                            </div>
                            {/* PEAK column — fills upward from the bottom like the RMS column */}
                            <div
                              className="hw-led-track !flex-col-reverse w-[9px]"
                              role="meter"
                              aria-label={`Channel ${ch.index} peak level meter`}
                              aria-valuenow={Math.round(pNorm * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              {Array.from({ length: 8 }).map((_, seg) => {
                                const lit = assigned && !ch.mute && pNorm >= (seg + 1) / 8 - 0.999 / 8;
                                const color = seg >= 7 ? 'red' : seg >= 6 ? 'amber' : 'cyan';
                                return (
                                  <span
                                    key={seg}
                                    className="hw-led-seg"
                                    data-lit={lit ? color : undefined}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        </div>

                        {/* preamp gain position knob (machined display) + mix-bus LED column */}
                        <div
                          className="flex flex-col items-center justify-center gap-1.5 shrink-0"
                          title={`CH${ch.index} ${mSpec.shortLabel} preamp ${mSpec.formatGain(ch.gainDb)} dB · fader ${ch.faderDb > 0 ? '+' : ''}${ch.faderDb.toFixed(1)} dB · mix bus: PA ${paOn ? 'ON' : 'off'} · STREAM ${stOn ? 'ON' : 'off'} · SUB ${sbOn ? 'ON' : 'off'} — adjust in the central INPUT CONDITIONING card`}
                        >
                          <div
                            aria-hidden="true"
                            className={`hw-knob-face relative w-[22px] h-[22px] rounded-full shrink-0 ring-1 ${
                              mode === 'inst'
                                ? 'ring-fuchsia-400/50'
                                : mode === 'line'
                                  ? 'ring-emerald-400/50'
                                  : 'ring-cyan-400/50'
                            }`}
                          >
                            <span
                              className="absolute left-1/2 top-[2px] w-[1.5px] h-[8px] rounded-full bg-slate-100 shadow-[0_0_2px_rgba(0,0,0,0.9)]"
                              style={{
                                transformOrigin: '50% 9px',
                                transform: `translateX(-50%) rotate(${
                                  -135 +
                                  270 *
                                    Math.max(
                                      0,
                                      Math.min(
                                        1,
                                        (ch.gainDb - mSpec.gainMin) / (mSpec.gainMax - mSpec.gainMin)
                                      )
                                    )
                                }deg)`,
                              }}
                            />
                          </div>
                          <span
                            className="flex items-center gap-[3px]"
                            title={`Mix bus assigns · PA ${paOn ? 'ON' : 'off'} · Stream ${stOn ? 'ON' : 'off'} · Sub ${sbOn ? 'ON' : 'off'}`}
                          >
                            <span
                              aria-hidden="true"
                              className={`w-[5px] h-[5px] rounded-full ${
                                paOn ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.8)]' : 'bg-[#1B232E]'
                              }`}
                            />
                            <span
                              aria-hidden="true"
                              className={`w-[5px] h-[5px] rounded-full ${
                                stOn ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.8)]' : 'bg-[#1B232E]'
                              }`}
                            />
                            <span
                              aria-hidden="true"
                              className={`w-[5px] h-[5px] rounded-full ${
                                sbOn ? 'bg-fuchsia-400 shadow-[0_0_4px_rgba(232,121,249,0.8)]' : 'bg-[#1B232E]'
                              }`}
                            />
                            <span className="sr-only">
                              {`CH${ch.index} mix bus assigns: Main PA ${paOn ? 'on' : 'off'}, stream ${stOn ? 'on' : 'off'}, sub ${sbOn ? 'on' : 'off'}`}
                            </span>
                          </span>
                        </div>

                        {/* quick per-row MUTE / SOLO keys */}
                        <div className="flex flex-col gap-1 shrink-0">
                          <button
                            type="button"
                            disabled={!assigned || locked}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateChannel(ch.id, { mute: !ch.mute });
                            }}
                            aria-pressed={assigned ? Boolean(ch.mute) : undefined}
                            aria-label={`Channel ${ch.index} mute — currently ${ch.mute ? 'MUTED' : 'active'} (click to ${ch.mute ? 'unmute' : 'mute'})`}
                            title={ch.mute ? `Unmute CH${ch.index}` : `Mute CH${ch.index}`}
                            className={`w-[22px] h-[22px] rounded border font-mono text-[9px] font-bold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hw-key ${
                              assigned && ch.mute
                                ? '!bg-none !border-rose-300 !bg-rose-600 !text-white shadow-[0_0_6px_rgba(244,63,94,0.6)]'
                                : ''
                            }`}
                          >
                            M
                          </button>
                          <button
                            type="button"
                            disabled={!assigned || locked}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUpdateChannel(ch.id, { solo: !ch.solo });
                            }}
                            aria-pressed={assigned ? Boolean(ch.solo) : undefined}
                            aria-label={`Channel ${ch.index} solo — currently ${ch.solo ? 'SOLOED' : 'off'} (click to ${ch.solo ? 'clear solo' : 'solo'})`}
                            title={ch.solo ? `Clear solo CH${ch.index}` : `Solo CH${ch.index}`}
                            className={`w-[22px] h-[22px] rounded border font-mono text-[9px] font-bold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hw-key ${
                              assigned && ch.solo
                                ? '!bg-none !border-amber-200 !bg-amber-400 !text-slate-950 shadow-[0_0_6px_rgba(245,158,11,0.55)]'
                                : ''
                            }`}
                          >
                            S
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ==== GUITAR FX RACK — the selected channel's pedalboard
                    insert (kept from the old strip; per-channel, not repeated
                    anywhere else on the console) ==== */}
              {onUpdateChannelFx && (
                <div className="shrink min-h-0 max-h-[42%] overflow-y-auto px-1.5 pb-1.5 pt-1">
                  <ChannelFxRackPanel
                    channel={selectedChannel}
                    engineRunning={engineRunning}
                    onUpdateChannelFx={onUpdateChannelFx}
                  />
                </div>
              )}
            </div>
          ) : (
            <div
              className="flex-1 min-h-0 flex items-center justify-center p-3"
              title="No input channels — press + (panel header) to add a strip"
            >
              <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                <span className="hw-lamp" style={{ width: 6, height: 6 }} aria-hidden="true" />
                No Channels · ADD
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
                  <span className="truncate">INPUT PATCH ({inputDevices.length})</span>
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
                  <span>{scanning ? 'SCANNING…' : `RESCAN · ${inputDevices.length}`}</span>
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
                      <span className="truncate">AUDIO BRIDGE</span>
                      <span
                        aria-hidden="true"
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          audioSource === 'desktop-audio' && engineRunning
                            ? 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.85)]'
                            : 'bg-slate-600'
                        }`}
                      />
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
                    <span className="truncate">BROWSER → DSP SPEAKERS</span>
                  </button>
                )}
                {inputDevices.length === 0 ? (
                  <div
                    className="p-2 rounded border border-dashed border-[#344355] bg-[#0B1015] text-center font-mono text-[9px] text-slate-500 flex items-center justify-center gap-1.5"
                    title="No inputs detected — press RESCAN to scan USB / soundcard inputs"
                  >
                    <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
                    NO INPUTS · RESCAN
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
                  // Physical card order = ascending first channel index (front
                  // pair first, generated aux pairs after the named slots) —
                  // derives from the device's own endpoints so any channel
                  // count orders itself correctly.
                  const ordered = [...deviceJacks].sort(
                    (a, b) => a.channelIndices[0] - b.channelIndices[0]
                  );
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
                              first.layout === '5.1'
                                ? 'text-cyan-300 border-cyan-500/40 bg-cyan-950/40'
                                : 'text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-950/40'
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
                            title="Church-install auto patch: Main PA → FRONT (green), Sub → CENTER/SUB (orange), Overflow/Rear-fill → REAR (black), Stage monitor → SIDE (grey). Aux jacks are manual-assign only."
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
                      <div
                        className="flex items-center gap-1.5 px-1 py-0.5 rounded border border-[#2A3644] bg-[#0C1118] font-mono text-[7px] font-bold tracking-wider text-slate-400"
                        title={`${jackRouterStatus} · ${
                          first.layout === '5.1' || first.layout === '7.1'
                            ? `Windows speaker configuration for this device must be set to ${first.layout} (Sound Control Panel) for 1:1 per-jack routing.`
                            : `Windows speaker configuration for this device must be configured for ${first.channelCount} discrete channels (Sound Control Panel or vendor control panel) for 1:1 per-jack routing.`
                        }`}
                      >
                        <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
                        {jackRouterStatus} · WIN {first.layout ?? `${first.channelCount}CH`} REQ
                      </div>
                    </div>
                  );
                });
              })()}

            {/* ==== NATIVE WASAPI ENGINE (v2 per-jack path — desktop app only) ==== */}
            {(() => {
              const sinkJack = outputJackEndpoints.find(
                (j) => j.parentDeviceId === preferredOutputDeviceId && !j.simulated
              );
              const sinkChannels = sinkJack?.channelCount ?? 0;
              if (!isDesktopApp() || sinkChannels < 4) return null;
              const engine = liveAudioEngine.getRawOutputEngineStatus();
              return (
                <div className="rounded-md border border-[#3A4B5E] bg-gradient-to-b from-[#1B2431] to-[#121821] p-1.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-1 px-0.5">
                    <span className="flex items-center gap-1 min-w-0">
                      <Cable className="w-3 h-3 text-amber-300 shrink-0" />
                      <span className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-amber-300">
                        Native WASAPI Engine
                      </span>
                      <span
                        className={`px-1 py-0.5 rounded border font-mono text-[7px] font-bold shrink-0 ${
                          engine.active
                            ? engine.exclusive
                              ? 'text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-950/40'
                              : 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40'
                            : 'text-slate-400 border-slate-600/50 bg-slate-900/40'
                        }`}
                      >
                        {nativeEngineStatus}
                      </span>
                    </span>
                    <span className="font-mono text-[7.5px] text-slate-500 truncate">
                      {sinkChannels}ch sink
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    {/* Share-mode selector */}
                    <div className="flex p-0.5 rounded border border-[#293544] bg-[#0B1017]" role="group" aria-label="WASAPI share mode">
                      {(['shared', 'exclusive'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          disabled={engine.active || nativeJackEngineBusy || locked}
                          onClick={() => setNativeJackEngineMode(mode)}
                          title={
                            mode === 'shared'
                              ? 'SHARED — mixed by the Windows audio engine (AUTOCONVERTPCM); coexists with system audio.'
                              : 'EXCLUSIVE — bit-perfect event-driven stream, no shared mixer or APO interference; the device is held by the console alone (close other DAWs first).'
                          }
                          className={`px-2 h-6 rounded font-mono text-[8px] font-bold cursor-pointer disabled:opacity-45 ${
                            nativeJackEngineMode === mode
                              ? mode === 'exclusive'
                                ? 'bg-fuchsia-500/25 text-fuchsia-200 border border-fuchsia-500/45'
                                : 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/45'
                              : 'text-slate-400 hover:text-slate-200 border border-transparent'
                          }`}
                        >
                          {mode === 'shared' ? 'SHARED' : 'EXCLUSIVE'}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      disabled={nativeJackEngineBusy || locked}
                      onClick={() =>
                        void handleToggleNativeJackEngine(
                          !engine.active,
                          preferredOutputDeviceId,
                          sinkChannels
                        )
                      }
                      title={
                        engine.active
                          ? 'Disarm the native engine — output returns to the Web Audio destination.'
                          : `Arm the native engine on the active sink (${sinkChannels} channels) — per-jack zone mixes render through the native WASAPI stream.`
                      }
                      className={`flex-1 h-7 rounded border font-mono text-[8.5px] font-bold cursor-pointer disabled:opacity-45 ${
                        engine.active
                          ? 'border-rose-500/50 bg-rose-950/40 hover:bg-rose-900/50 text-rose-200'
                          : 'border-amber-500/50 bg-amber-950/35 hover:bg-amber-900/50 text-amber-200'
                      }`}
                    >
                      {nativeJackEngineBusy
                        ? 'ARMING…'
                        : engine.active
                          ? 'DISARM NATIVE ENGINE'
                          : `ARM ${nativeJackEngineMode === 'exclusive' ? 'EXCLUSIVE' : 'SHARED'} ENGINE`}
                    </button>
                  </div>

                  {nativeJackEngineNote && (
                    <p
                      role="status"
                      className="font-mono text-[7px] leading-relaxed text-slate-400 px-0.5"
                    >
                      {nativeJackEngineNote}
                    </p>
                  )}
                  <p className="font-mono text-[7px] leading-relaxed text-slate-500 px-0.5">
                    Native engine takes over the sink&apos;s {sinkChannels}-channel stream — each jack
                    pair below carries its zone mix 1:1. EXCLUSIVE holds the device bit-perfect
                    (float32, integer-PCM fallback). Disarm to return to browser Web Audio output.
                  </p>
                </div>
              );
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
                  onClick={() => void openWindowsSoundSettings('mmsys')}
                  title="Open Windows Sound Control Panel (mmsys.cpl) — click Configure on your PCIe card and select 5.1 or 7.1 Surround so Windows unlocks all rear jacks"
                  className="h-7 px-1.5 rounded border border-[#293544] bg-[#0B1017] text-slate-400 hover:text-white font-mono text-[8.5px] font-bold cursor-pointer shrink-0"
                >
                  5.1/7.1 SETUP
                </button>
              )}
            </div>

            {outputDevices.length === 0 ? (
              <div
                className="p-3 rounded border border-dashed border-[#344355] bg-[#0B1015] text-center font-mono text-[10px] font-bold tracking-wider text-slate-500 uppercase flex items-center justify-center gap-1.5"
                title="No audio output endpoints detected — press RESCAN or plug in speakers/headphones"
              >
                <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
                No Outputs · Rescan
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
                        <button
                          key={z.id}
                          type="button"
                          disabled={locked || !onUpdateZone}
                          onClick={() => onUpdateZone?.(z.id, { mute: !z.mute })}
                          title={`Click to ${z.mute ? 'turn ON' : 'MUTE'} ${z.name} on ${devLabel}`}
                          className={`px-1.5 py-0.5 rounded border truncate max-w-[130px] cursor-pointer disabled:opacity-45 ${
                            z.mute
                              ? 'bg-rose-950/40 text-rose-300 border-rose-500/40 line-through'
                              : 'bg-teal-500/20 text-teal-200 border-teal-400/50 font-bold'
                          }`}
                        >
                          {z.mute ? `OFF: ${z.name}` : `● ${z.name}`}
                        </button>
                      ))}
                      {!isMasterOut && !isStreamOut && assignedZones.length === 0 && (
                        <span className="text-slate-500 italic">Available port</span>
                      )}
                    </div>

                    {onUpdateZone && zones.length > 0 && (
                      <div className="pt-0.5">
                        <select
                          aria-label={`Route speaker zone simultaneously to ${devLabel}`}
                          value=""
                          disabled={locked}
                          onChange={(e) => {
                            const zoneId = e.target.value;
                            if (!zoneId) return;
                            onUpdateZone(zoneId, {
                              hardwareOutputId: dev.deviceId,
                              hardwareOutput: devLabel,
                              outputJackId: undefined,
                              mute: false,
                            });
                          }}
                          className="w-full h-6 px-1.5 rounded border border-[#2C394A] bg-[#0B1017] text-teal-200 font-mono text-[8.5px] cursor-pointer disabled:opacity-45"
                        >
                          <option value="">+ ROUTE ZONE…</option>
                          {zones.map((z) => (
                            <option key={z.id} value={z.id}>
                              {z.hardwareOutputId === dev.deviceId ? `✓ ${z.name} (${z.role})` : `→ ${z.name} (${z.role})`}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

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
                  ? 'SCANNING…'
                  : `RESCAN · ${outputDevices.length}`}
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

