import React, { useEffect, useRef, useState } from 'react';
import {
  Radio,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Settings2,
  Key,
  Eye,
  EyeOff,
  X,
  Info,
  Lock,
  Circle,
  Volume2,
  VolumeX,
  ArrowRightLeft,
} from 'lucide-react';
import { liveAudioEngine } from '../audio/liveAudioEngine.ts';
import type {
  BroadcastDspConfig,
  HardwareDevice,
  ObsStatus,
  SignalTelemetry,
} from '../types/audio.ts';
import {
  ArcGauge,
  ConsolePushButton,
  RotaryKnob,
  SegmentedLedMeter,
} from './StudioControls.tsx';
import { obsWsService, type ObsConnectionState } from '../services/obsWebSocket.ts';
import { openHelpTopic } from './HelpDeskModule.tsx';

interface LivestreamObsModuleProps {
  broadcastDsp: BroadcastDspConfig;
  onUpdateBroadcastDsp: (patch: Partial<BroadcastDspConfig>) => void;
  obsStatus: ObsStatus;
  onUpdateObs: (patch: Partial<ObsStatus>) => void;
  telemetry: SignalTelemetry;
  device: HardwareDevice;
  processedOutputActive: boolean;
  onEnableProcessedOutput: () => void;
}

export const LivestreamObsModule: React.FC<LivestreamObsModuleProps> = ({
  broadcastDsp,
  onUpdateBroadcastDsp,
  obsStatus,
  onUpdateObs,
  telemetry,
  device,
  processedOutputActive,
  onEnableProcessedOutput,
}) => {
  const [obsState, setObsState] = useState<ObsConnectionState>(() => obsWsService.getState());
  const [speechStemDb, setSpeechStemDb] = useState<number>(0);
  const [bandStemDb, setBandStemDb] = useState<number>(-2.5);
  const [roomAmbiencePct, setRoomAmbiencePct] = useState<number>(18);
  const [fastRoomDb, setFastRoomDb] = useState<number>(-96);
  const [fastRoomPeakDb, setFastRoomPeakDb] = useState<number>(-96);
  const [fastStreamDb, setFastStreamDb] = useState<number>(-96);
  const [fastStreamPeakDb, setFastStreamPeakDb] = useState<number>(-96);
  const [designatedObsInput, setDesignatedObsInput] = useState<string>('');
  const [exclusiveAudioLock, setExclusiveAudioLock] = useState<boolean>(false);
  const lastAutoMutedRef = useRef<Map<string, boolean>>(new Map());
  const scopeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformHistoryRef = useRef<number[]>(new Array(96).fill(0.02));

  // Settings & Banner Controls
  const [showSettings, setShowSettings] = useState(false);
  const [wsUrl, setWsUrl] = useState(() => obsWsService.getConfig().url);
  const [wsPassword, setWsPassword] = useState(() => obsWsService.getConfig().password);
  const [showPassword, setShowPassword] = useState(false);
  const [dismissedStereoNote, setDismissedStereoNote] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('church_audio_stereo_note_dismissed') === 'true';
    } catch {
      return false;
    }
  });
  const [dismissedOfflineWarning, setDismissedOfflineWarning] = useState(false);

  const onUpdateObsRef = useRef(onUpdateObs);
  onUpdateObsRef.current = onUpdateObs;
  const lastObsPersistSigRef = useRef<string>('');
  const processedAudioSource = obsState.audioInputs.find(
    (input) => input.inputName.trim().toLocaleLowerCase() === 'hkm processed audio'
  );

  // Subscribe to live OBS WebSocket service.
  //
  // Volatile telemetry (bitrate, dropped frames, CPU %, timecode) updates
  // roughly every 1.8s while OBS is connected and is kept ONLY in local
  // component state. The session-level obsStatus (which feeds the debounced
  // /api/state/sync persistence loop) is updated only when a persistable
  // field actually changes — otherwise a 24/7-connected OBS causes a full
  // ~250KB state PUT + JSON store rewrite every ~2 seconds around the clock.
  useEffect(() => {
    const unsub = obsWsService.subscribe((next) => {
      setObsState(next);
      const persistSig = [
        next.connected,
        next.telemetry.streaming,
        next.telemetry.recording,
        next.activeScene,
        next.scenes.length,
        wsUrl,
      ].join('|');
      if (persistSig !== lastObsPersistSigRef.current) {
        lastObsPersistSigRef.current = persistSig;
        onUpdateObsRef.current({
          connected: next.connected,
          streaming: next.telemetry.streaming,
          recording: next.telemetry.recording,
          activeScene: next.activeScene,
          scenes: next.scenes,
          websocketUrl: wsUrl,
        });
      }
    });
    return unsub;
  }, [wsUrl]);

  // 60fps fast VU meters + live broadcast waveform scope
  useEffect(() => {
    if (!telemetry.isRunning) {
      setFastRoomDb(-96);
      setFastRoomPeakDb(-96);
      setFastStreamDb(-96);
      setFastStreamPeakDb(-96);
      return;
    }

    let timerId: number | null = null;
    let cancelled = false;
    // Quantize meter state to 0.5 dB and only commit changed values: raw float
    // setState at 30fps re-rendered the whole 1k-line module tree ~30×/sec.
    const qHalf = (v: number) => Math.round(v * 2) / 2;
    const setIfChanged = (
      setter: (fn: (prev: number) => number) => void,
      next: number
    ) => setter((prev) => (prev === next ? prev : next));
    const renderScope = () => {
      timerId = null;
      if (document.hidden) return;

      const fast = liveAudioEngine.sampleFastLevels();
      const running = fast.isRunning;
      const roomRms = running ? fast.postRmsDb : telemetry.isRunning ? telemetry.postRmsDb : -96;
      const roomPeak = running ? fast.postPeakDb : telemetry.isRunning ? telemetry.postPeakDb : -96;
      const boost = broadcastDsp.enabled ? 3.5 : 0;
      const streamRms = roomRms > -90 ? Math.min(broadcastDsp.limiterCeilingDb, roomRms + boost) : -96;
      const streamPeak = roomPeak > -90 ? Math.min(broadcastDsp.limiterCeilingDb, roomPeak + boost) : -96;

      setIfChanged(setFastRoomDb, qHalf(roomRms));
      setIfChanged(setFastRoomPeakDb, qHalf(roomPeak));
      setIfChanged(setFastStreamDb, qHalf(streamRms));
      setIfChanged(setFastStreamPeakDb, qHalf(streamPeak));

      const amp = streamRms > -90 ? Math.max(0.03, Math.min(1, (streamRms + 54) / 54)) : 0.02;
      const hist = waveformHistoryRef.current;
      hist.push(amp);
      if (hist.length > 96) hist.shift();

      const canvas = scopeCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);
          ctx.fillStyle = '#05080E';
          ctx.fillRect(0, 0, w, h);

          // Target -14 LUFS guide line
          const targetY = h * 0.28;
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(0, targetY);
          ctx.lineTo(w, targetY);
          ctx.stroke();
          ctx.setLineDash([]);

          const barW = w / hist.length;
          for (let i = 0; i < hist.length; i++) {
            const v = hist[i];
            const barH = Math.max(2, v * (h - 10));
            const x = i * barW;
            const y = (h - barH) / 2;
            ctx.fillStyle = v > 0.88 ? '#F59E0B' : broadcastDsp.enabled ? '#10B981' : '#38BDF8';
            ctx.fillRect(x, y, Math.max(1.5, barW - 1.5), barH);
          }
        }
      }

      if (!cancelled) timerId = window.setTimeout(renderScope, 33);
    };

    const onVis = () => {
      if (!document.hidden && timerId === null) renderScope();
    };
    if (!document.hidden) renderScope();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [broadcastDsp.enabled, broadcastDsp.limiterCeilingDb, telemetry.isRunning]);

  // Auto-select designated OBS broadcast input & enforce exclusive audio lock if enabled
  useEffect(() => {
    if (!obsState.connected || obsState.audioInputs.length === 0) {
      lastAutoMutedRef.current.clear();
      return;
    }
    let resolvedDesignated = designatedObsInput;
    if (!resolvedDesignated) {
      const preferred =
        obsState.audioInputs.find((i) =>
          i.inputName.trim().toLocaleLowerCase() === 'hkm processed audio'
        ) ?? obsState.audioInputs.find((i) =>
          /cable|desktop|loopback|hkm|church/i.test(i.inputName)
        ) ?? obsState.audioInputs[0];
      if (preferred) {
        resolvedDesignated = preferred.inputName;
        setDesignatedObsInput(preferred.inputName);
      }
    }
    if (!exclusiveAudioLock) {
      lastAutoMutedRef.current.clear();
      return;
    }
    if (resolvedDesignated) {
      obsState.audioInputs.forEach((inp) => {
        const shouldMute = inp.inputName !== resolvedDesignated;
        if (inp.muted !== shouldMute && lastAutoMutedRef.current.get(inp.inputName) !== shouldMute) {
          lastAutoMutedRef.current.set(inp.inputName, shouldMute);
          void obsWsService.setInputMute(inp.inputName, shouldMute);
        }
      });
    }
  }, [obsState.connected, obsState.audioInputs, designatedObsInput, exclusiveAudioLock]);

  const handleEnforceExclusiveObsAudio = async () => {
    const target = designatedObsInput || obsState.audioInputs[0]?.inputName;
    if (!target) return;
    setDesignatedObsInput(target);
    setExclusiveAudioLock(true);
    for (const inp of obsState.audioInputs) {
      await obsWsService.setInputMute(inp.inputName, inp.inputName !== target);
    }
  };

  const handleSyncAvOffsetToObs = async () => {
    const target = designatedObsInput || obsState.audioInputs[0]?.inputName;
    if (!target) return;
    await obsWsService.setInputAudioSyncOffset(target, broadcastDsp.avSyncOffsetMs);
  };

  const roomLufs = telemetry.isRunning ? telemetry.estimatedLufs : -70;
  const broadcastLufs = telemetry.isRunning
    ? Math.max(-36, Math.min(-11.5, roomLufs + (broadcastDsp.enabled ? 3.2 : 0)))
    : -70;
  const lufsDelta = telemetry.isRunning
    ? Number((broadcastLufs - broadcastDsp.targetLufs).toFixed(1))
    : 0;

  const handleConnectObs = () => {
    setDismissedOfflineWarning(false);
    obsWsService.connect(wsUrl, wsPassword);
  };

  const handleDisconnectObs = () => {
    obsWsService.disconnect();
  };

  const handleToggleStream = async () => {
    await obsWsService.toggleStream();
  };

  const handleSceneClick = async (scene: string) => {
    if (obsState.connected) {
      await obsWsService.setProgramScene(scene);
    } else {
      onUpdateObs({ activeScene: scene });
    }
  };

  const handleSyncCheck = async () => {
    if (obsState.connected) {
      await obsWsService.syncInitialObsState();
    }
  };

  const handleDismissStereoNote = () => {
    setDismissedStereoNote(true);
    try {
      window.localStorage.setItem('church_audio_stereo_note_dismissed', 'true');
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-4">
      {/* Studio Broadcast Header */}
      <div className="rounded-lg border border-slate-800 bg-gradient-to-b from-[#161D29] to-[#0E131C] p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`hw-lamp ${obsState.telemetry.streaming ? 'animate-pulse' : ''}`}
            style={{ width: 8, height: 30 }}
            data-on={
              obsState.telemetry.streaming ? 'red' : obsState.connected ? 'green' : 'cyan'
            }
            aria-hidden="true"
          />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-bold text-sky-400">08</span>
              <h1
                className="font-display text-lg font-semibold text-white tracking-tight flex items-center gap-2"
                title="Livestream Broadcast & OBS Studio Console"
              >
                <span>LIVESTREAM · OBS CONSOLE</span>
                {obsState.connected ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                    <span className="hw-lamp animate-pulse" style={{ width: 5, height: 5 }} data-on="green" aria-hidden="true" />
                    CONNECTED
                  </span>
                ) : obsState.connecting ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-amber-500/15 border border-amber-500/30 text-amber-300">
                    <span className="hw-lamp animate-pulse" style={{ width: 5, height: 5 }} data-on="amber" aria-hidden="true" />
                    CONNECTING...
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-slate-800 border border-slate-700 text-slate-400">
                    <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
                    STANDBY
                  </span>
                )}
              </h1>
            </div>
            <p
              className="text-[11px] font-mono text-slate-400"
              title={
                telemetry.isRunning
                  ? `Dedicated Stream Bus (${broadcastDsp.targetLufs} LUFS · Δ ${lufsDelta > 0 ? `+${lufsDelta}` : lufsDelta}) · A/V Sync Offset · Loop Guard`
                  : `Stream Bus Standby (Target ${broadcastDsp.targetLufs} LUFS) · A/V Sync Offset · Loop Guard`
              }
            >
              {telemetry.isRunning
                ? `STREAM BUS · ${broadcastDsp.targetLufs} LUFS · Δ ${lufsDelta > 0 ? `+${lufsDelta}` : lufsDelta}`
                : `STREAM BUS SBY · TGT ${broadcastDsp.targetLufs} LUFS`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((prev) => !prev)}
            title="Configure OBS WebSocket Host, Port & Password"
            aria-pressed={showSettings}
            className={`h-8 px-2.5 rounded border font-mono text-[11px] flex items-center gap-1.5 transition-colors cursor-pointer hw-key ${
              showSettings ? '!bg-none !border-sky-400 !bg-sky-500/20 !text-sky-200' : ''
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>WS CONFIG</span>
          </button>

          {obsState.connected ? (
            <ConsolePushButton
              label="DISCONNECT WS"
              active={true}
              tone="emerald"
              onClick={handleDisconnectObs}
            />
          ) : (
            <ConsolePushButton
              label={obsState.connecting ? 'CONNECTING...' : 'CONNECT OBS WS'}
              active={false}
              tone="emerald"
              onClick={handleConnectObs}
            />
          )}

          <ConsolePushButton
            label={obsState.telemetry.streaming ? 'ON AIR · STOP STREAM' : 'GO LIVE (OBS)'}
            active={obsState.telemetry.streaming}
            tone="red"
            disabled={!obsState.connected}
            onClick={handleToggleStream}
          />
        </div>
      </div>

      {/* OBS connection failure surfacing — the service already computes
          human-readable disconnect reasons (wrong password, OBS not running,
          unreachable host); showing them turns a silent dead button into an
          actionable message. */}
      {!obsState.connected && obsState.error && (
        <div
          role="alert"
          className="px-3.5 py-2 rounded-lg border border-amber-500/40 bg-amber-950/30 text-amber-200 text-xs font-mono flex flex-wrap items-center justify-between gap-2"
        >
          <span
            className="flex items-center gap-2"
            title={`OBS connection: ${obsState.error}${obsState.authRequired ? ' — open WS CONFIG below and verify the password.' : ''}`}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>
              WS FAULT · <strong className="text-amber-100">{obsState.error}</strong>
            </span>
          </span>
          <button
            type="button"
            onClick={handleConnectObs}
            title="Retry the OBS WebSocket connection"
            className="px-2.5 py-1 rounded border border-amber-400/60 text-amber-100 font-bold text-[10px] cursor-pointer shrink-0 hw-key !bg-none !border-amber-400/60 !bg-amber-500/20 !text-amber-100"
          >
            RETRY CONNECT
          </button>
        </div>
      )}

      {/* Expandable OBS WebSocket Configuration Drawer */}
      {showSettings && (
        <div className="p-3.5 rounded-lg border border-slate-700 bg-[#0B0F19] text-xs font-mono space-y-3">
          <div className="flex items-center justify-between text-slate-300 border-b border-slate-800 pb-2">
            <span
              className="font-semibold flex items-center gap-2 text-white"
              title="OBS Studio WebSocket v5 Connection Settings"
            >
              <Radio className="w-4 h-4 text-sky-400" />
              <span>OBS WEBSOCKET V5 · CONFIG</span>
            </span>
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="p-1 text-slate-400 hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label
                className="block text-[11px] text-slate-400 mb-1"
                title="WebSocket Server URL"
              >
                WS URL
              </label>
              <input
                type="text"
                aria-label="OBS WebSocket server URL"
                value={wsUrl}
                onChange={(e) => {
                  setWsUrl(e.target.value);
                  obsWsService.setConfig(e.target.value, wsPassword);
                }}
                placeholder="ws://127.0.0.1:4455"
                className="w-full px-2.5 py-1.5 rounded border border-slate-700 bg-[#141B28] text-white focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1 flex items-center justify-between">
                <span title="Server Password (SHA-256 Authenticated)">WS PASSWORD</span>
                <span className="text-[10px] text-slate-500" title="Auto-detected from OBS">
                  AUTO
                </span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  aria-label="OBS WebSocket password"
                  value={wsPassword}
                  onChange={(e) => {
                    setWsPassword(e.target.value);
                    obsWsService.setConfig(wsUrl, e.target.value);
                  }}
                  placeholder="PASSWORD"
                  className="w-full pl-8 pr-8 py-1.5 rounded border border-slate-700 bg-[#141B28] text-white focus:border-sky-500 focus:outline-none"
                />
                <Key className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span
              className="text-[11px] text-slate-400"
              title="Protocol: obs-websocket v5 · port 4455 must be enabled in OBS Studio settings"
            >
              OBS-WS v5 · PORT 4455
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleConnectObs}
                title="Test & Connect Now — open the OBS WebSocket link with the settings above"
                className="px-3 py-1 rounded text-white font-semibold text-xs cursor-pointer hw-key !bg-none !border-sky-500 !bg-sky-600 !text-white"
              >
                CONNECT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OBS Offline status strip — connection state as LEDs + keys, guide
          text lives in the Help Desk (Livestream topic) */}
      {!obsState.connected && !dismissedOfflineWarning && (
        <div className="px-3 py-2 rounded-lg border border-slate-800 bg-[#0C101A] flex items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="relative flex items-center justify-center shrink-0" title="OBS WebSocket: disconnected">
              <span className="absolute w-3.5 h-3.5 rounded-full bg-sky-500/30 animate-ping" />
              <span
                className="hw-lamp"
                style={{ width: 8, height: 8 }}
                data-on="cyan"
                aria-hidden="true"
              />
            </span>
            <span className="font-mono text-[11px] font-bold text-white tracking-wider shrink-0">
              OBS STANDBY
            </span>
            <span className="font-mono text-[10px] text-slate-500 truncate">{wsUrl}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleConnectObs}
              title="Retry the OBS WebSocket connection (obs-websocket v5 · port 4455, enabled in OBS Studio settings)"
              className="px-2.5 py-1 rounded border text-[10px] font-mono font-bold tracking-wider cursor-pointer hw-key !bg-none !border-sky-500/50 !bg-sky-500/10 !text-sky-300"
            >
              RETRY WS
            </button>
            <button
              type="button"
              onClick={() => setDismissedOfflineWarning(true)}
              title="Dismiss note"
              aria-label="Dismiss OBS standby note"
              className="p-1 text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* OBS APP CAPTURE OF HKM'S POST-DSP OUTPUT (NO VIRTUAL DRIVER)
          Console-style: LED status row + operational keys. The 4-step OBS
          setup walkthrough lives in the Help Desk (Livestream topic). */}
      <div className="p-3 rounded-xl border border-emerald-500/40 bg-gradient-to-r from-[#081814] via-[#09141E] to-[#070B13] flex flex-col gap-2.5 shadow-lg">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 shrink-0">
              <Radio className="w-4 h-4" />
            </div>
            <span
              className="font-mono text-xs font-bold text-white uppercase tracking-wider shrink-0"
              title="Send Processed HKM Audio to OBS"
            >
              HKM AUDIO → OBS
            </span>
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border shrink-0 flex items-center gap-1 ${
                processedAudioSource
                  ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                  : 'bg-amber-500/15 border-amber-500/50 text-amber-200'
              }`}
            >
              <span
                className="hw-lamp"
                style={{ width: 5, height: 5 }}
                data-on={processedAudioSource ? 'green' : 'amber'}
                aria-hidden="true"
              />
              {processedAudioSource ? 'SOURCE DETECTED' : 'AWAITING SOURCE'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`px-2 py-1 rounded border font-mono text-[9px] font-bold tracking-wider flex items-center gap-1 ${
                processedOutputActive
                  ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                  : 'border-amber-500/50 bg-amber-500/10 text-amber-200'
              }`}
              title={processedOutputActive
                ? "HKM is rendering the processed signal to its selected output; OBS can capture this application audio."
                : 'OBS can capture the signal while HKM renders it. Start the processed output route below; the same signal will play through the selected speakers.'}
            >
              <span
                className="hw-lamp"
                style={{ width: 5, height: 5 }}
                data-on={processedOutputActive ? 'green' : 'amber'}
                aria-hidden="true"
              />
              {processedOutputActive ? 'OUTPUT LIVE' : 'OUTPUT STANDBY'}
            </span>
            <button
              type="button"
              onClick={() => openHelpTopic('livestream')}
              title="Open the OBS Application Audio Capture setup walkthrough in the Help Desk"
              className="px-2 py-1 rounded border font-mono text-[9px] font-bold tracking-wider cursor-pointer hw-key"
            >
              SETUP GUIDE
            </button>
          </div>
        </div>

        {/* Silkscreen capability chips — engraved facts, not sentences */}
        <div className="flex items-center gap-1.5 flex-wrap font-mono text-[9px] font-bold tracking-wider">
          <span className="px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-950/40 text-emerald-300/90"
            title="OBS captures HKM's post-DSP application audio with its built-in Application Audio Capture source">
            APP CAPTURE
          </span>
          <span className="px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-950/40 text-emerald-300/90"
            title="No VB-Audio cable or extra audio driver required">
            NO VIRTUAL CABLE
          </span>
          <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-[#0A0F16] text-slate-400"
            title="OBS receives the main console DSP output; the broadcast mastering rack below is not inserted into this application audio path">
            MAIN DSP BUS
          </span>
          <span className={`px-1.5 py-0.5 rounded border ${
            obsState.connected
              ? 'border-sky-400/50 bg-sky-500/10 text-sky-300'
              : 'border-slate-700 bg-[#0A0F16] text-slate-500'
          }`}
            title={obsState.connected
              ? 'OBS WebSocket is connected and HKM can detect the named source'
              : 'Connect OBS WebSocket to let HKM detect the named source here; application capture itself works without WebSocket'}>
            WS {obsState.connected ? 'LINKED' : 'OFFLINE'}
          </span>
        </div>

        {/* Live source readout + start key */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0 font-mono text-[10px]">
            <span
              className="hw-lamp shrink-0"
              style={{ width: 5, height: 5 }}
              data-on={processedAudioSource ? 'green' : undefined}
              aria-hidden="true"
            />
            <span className={processedAudioSource ? 'text-emerald-300 truncate' : 'text-slate-500 truncate'}>
              {processedAudioSource
                ? `SOURCE: ${processedAudioSource.inputName} (${processedAudioSource.inputKind})`
                : obsState.connected
                  ? 'WS LINKED · NO SOURCE'
                  : 'NO SOURCE'}
            </span>
          </div>
          {!processedOutputActive && (
            <button
              type="button"
              onClick={onEnableProcessedOutput}
              title="Start HKM processed output — render the processed signal to the selected output"
              className="px-3 py-1.5 rounded border border-emerald-400/60 text-emerald-100 font-mono text-[10px] font-bold cursor-pointer hw-key !bg-none !border-emerald-400/60 !bg-emerald-600/25 !text-emerald-100"
            >
              START OUTPUT
            </button>
          )}
        </div>
      </div>

      {/* Stereo Bus Advisory Card (Dismissible & Clean) */}
      {!device.capabilities.perChannelCapture && (
        dismissedStereoNote ? (
          <div className="flex items-center justify-between px-3 py-1.5 rounded border border-slate-800 bg-[#0A0E16] text-[11px] font-mono text-slate-400">
            <span
              className="flex items-center gap-2"
              title={`Stereo Bus Mode: summed 2-channel USB (${device.model}) — broadcast EQ/limiting processes the summed stereo bus`}
            >
              <Info className="w-3.5 h-3.5 text-sky-400" />
              <span>STEREO 2-CH USB · {device.model}</span>
            </span>
            <button
              type="button"
              onClick={() => setDismissedStereoNote(false)}
              title="View routing note — why this mixer runs a summed stereo bus"
              className="text-sky-400 hover:underline"
            >
              ROUTING NOTE
            </button>
          </div>
        ) : (
          <div className="p-3 rounded-lg border border-slate-800 bg-[#0E131E] text-xs text-slate-300 flex items-center justify-between gap-3">
            <div
              className="flex items-center gap-2 min-w-0"
              title={`${device.model}: this mixer exposes a 2-channel USB stereo bus. Broadcast EQ/limiting processes the summed stereo bus; route AUX/GROUP outputs to a 4+ channel interface or digital mixer for separate stream stems.`}
            >
              <Info className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="font-semibold font-mono text-white shrink-0">
                ROUTING ADVISORY · {device.model}
              </span>
              <span className="px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300 font-mono text-[9px] font-bold tracking-wider shrink-0">
                2-CH USB STEREO BUS
              </span>
            </div>
            <button
              type="button"
              onClick={handleDismissStereoNote}
              className="px-2 py-0.5 rounded border text-[10px] font-mono text-slate-300 shrink-0 cursor-pointer hw-key"
              title="Acknowledge note"
            >
              ACK
            </button>
          </div>
        )
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
        {/* Left Broadcast DSP Processor */}
        <div className="xl:col-span-6 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <span
              className="font-mono text-xs font-semibold text-white uppercase hw-engraved"
              title="Broadcast Mastering & Sync Rack"
            >
              MASTERING &amp; SYNC RACK
            </span>
            <div className="flex items-center gap-1.5">
              <ConsolePushButton
                label={broadcastDsp.monoSum ? 'MONO SUM' : 'STEREO'}
                active={broadcastDsp.monoSum}
                tone="amber"
                onClick={() => onUpdateBroadcastDsp({ monoSum: !broadcastDsp.monoSum })}
              />
              <ConsolePushButton
                label={broadcastDsp.enabled ? 'DSP ACTIVE' : 'BYPASS'}
                active={broadcastDsp.enabled}
                tone="emerald"
                onClick={() => onUpdateBroadcastDsp({ enabled: !broadcastDsp.enabled })}
              />
            </div>
          </div>

          {/* Twin Room vs Stream Arc Gauges + LED Bars */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
            <div className="sm:col-span-4">
              <ArcGauge
                label="Sanctuary PA"
                value={telemetry.isRunning ? Math.max(0, 40 + roomLufs) : 0}
                max={40}
                displayValue={telemetry.isRunning ? `${roomLufs.toFixed(1)}` : '--'}
                sublabel="LUFS Room"
                tone="sky"
              />
            </div>
            <div className="sm:col-span-4 flex items-center justify-around py-2 bg-[#070A10] border border-slate-800 rounded">
              <div className="flex flex-col items-center gap-1">
                <SegmentedLedMeter
                  levelDb={fastRoomDb}
                  peakDb={fastRoomPeakDb}
                  height={98}
                  segments={14}
                />
                <span className="font-mono text-[9px] text-slate-400">ROOM</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <SegmentedLedMeter
                  levelDb={fastStreamDb}
                  peakDb={fastStreamPeakDb}
                  muted={!broadcastDsp.enabled}
                  height={98}
                  segments={14}
                />
                <span className="font-mono text-[9px] text-emerald-400 font-bold">STREAM</span>
              </div>
            </div>
            <div className="sm:col-span-4">
              <ArcGauge
                label="Broadcast Bus"
                value={telemetry.isRunning ? Math.max(0, 40 + broadcastLufs) : 0}
                max={40}
                displayValue={telemetry.isRunning ? `${broadcastLufs.toFixed(1)}` : '--'}
                sublabel={`Target ${broadcastDsp.targetLufs} LUFS`}
                tone="emerald"
              />
            </div>
          </div>

          {/* Broadcast Rotary Encoders */}
          <div className="grid grid-cols-5 gap-2 py-2.5 bg-[#070A10] border border-slate-800 rounded place-items-center">
            <RotaryKnob
              label="COMP THR"
              value={broadcastDsp.speechCompThresholdDb}
              min={-32}
              max={-8}
              step={1}
              defaultValue={-20}
              unit="dB"
              size={48}
              accent="sky"
              onChange={(next) => onUpdateBroadcastDsp({ speechCompThresholdDb: next })}
            />
            <RotaryKnob
              label="LOW-CUT"
              value={broadcastDsp.lowCutHz}
              min={40}
              max={160}
              step={5}
              defaultValue={90}
              unit="Hz"
              size={48}
              accent="amber"
              onChange={(next) => onUpdateBroadcastDsp({ lowCutHz: next })}
            />
            <RotaryKnob
              label="PRESENCE"
              value={broadcastDsp.presenceBoostDb}
              min={-3}
              max={6}
              step={0.5}
              defaultValue={1.5}
              unit="dB"
              size={48}
              accent="emerald"
              onChange={(next) => onUpdateBroadcastDsp({ presenceBoostDb: next })}
            />
            <RotaryKnob
              label="CEILING"
              value={broadcastDsp.limiterCeilingDb}
              min={-3}
              max={0}
              step={0.1}
              defaultValue={-1.0}
              unit="dB"
              size={48}
              accent="red"
              onChange={(next) => onUpdateBroadcastDsp({ limiterCeilingDb: next })}
            />
            <RotaryKnob
              label="A/V SYNC"
              value={broadcastDsp.avSyncOffsetMs}
              min={0}
              max={250}
              step={2}
              defaultValue={42}
              unit="ms"
              size={48}
              accent="sky"
              onChange={(next) => onUpdateBroadcastDsp({ avSyncOffsetMs: next })}
            />
          </div>

          {/* Broadcast Stem Balance & Loudness Drift */}
          <div className="p-3 rounded bg-[#070A10] border border-slate-800 grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
            <div className="sm:col-span-7 grid grid-cols-3 gap-2 place-items-center">
              <RotaryKnob
                label="SPEECH BUS"
                value={speechStemDb}
                min={-12}
                max={6}
                step={0.5}
                defaultValue={0}
                unit="dB"
                size={44}
                accent="emerald"
                onChange={setSpeechStemDb}
              />
              <RotaryKnob
                label="BAND MIX"
                value={bandStemDb}
                min={-18}
                max={3}
                step={0.5}
                defaultValue={-2.5}
                unit="dB"
                size={44}
                accent="sky"
                onChange={setBandStemDb}
              />
              <RotaryKnob
                label="ROOM MIC"
                value={roomAmbiencePct}
                min={0}
                max={60}
                step={2}
                defaultValue={18}
                unit="%"
                size={44}
                accent="amber"
                onChange={setRoomAmbiencePct}
              />
            </div>
            <div className="sm:col-span-5 font-mono text-[10px] space-y-1.5 border-t sm:border-t-0 sm:border-l border-slate-800 pt-2 sm:pt-0 sm:pl-3">
              <div className="flex justify-between text-slate-400">
                <span>LUFS TARGET DRIFT</span>
                <span className={Math.abs(lufsDelta) <= 1.5 ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
                  {lufsDelta > 0 ? `+${lufsDelta}` : lufsDelta} LU
                </span>
              </div>
              <div className="h-2 rounded-xs bg-[#0D1119] border border-slate-800 relative overflow-hidden">
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-600" />
                <div
                  className={`absolute top-0.5 bottom-0.5 w-2 rounded-xs ${Math.abs(lufsDelta) <= 1.5 ? 'bg-emerald-400' : 'bg-amber-400'}`}
                  style={{ left: `${Math.max(6, Math.min(88, 50 + lufsDelta * 6))}%` }}
                />
              </div>
              <div className="text-[9px] text-slate-500">
                YouTube/Facebook Target: {broadcastDsp.targetLufs} LUFS
              </div>
            </div>
          </div>

          {/* Live Broadcast Output Waveform Scope */}
          <div className="p-2.5 rounded bg-[#05080E] border border-emerald-500/25 space-y-1.5">
            <div className="flex items-center justify-between font-mono text-[10px]">
              <span className="text-emerald-300 font-bold uppercase flex items-center gap-1.5 hw-engraved !text-emerald-300">
                <span className="hw-lamp animate-pulse" style={{ width: 6, height: 6 }} data-on="green" aria-hidden="true" />
                STREAM SCOPE
              </span>
              <span className="text-slate-400 tabular-nums">
                Peak: <strong className="text-white">{fastStreamPeakDb > -90 ? `${fastStreamPeakDb.toFixed(1)} dBFS` : '--'}</strong> · Ceiling: {broadcastDsp.limiterCeilingDb.toFixed(1)} dB
              </span>
            </div>
            <canvas
              ref={scopeCanvasRef}
              width={520}
              height={54}
              className="w-full h-14 rounded border border-slate-800/80 block"
            />
          </div>
        </div>

        {/* Right OBS Studio Scene Matrix & Telemetry */}
        <div className="xl:col-span-6 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <span
              className="font-mono text-xs font-semibold text-white uppercase flex items-center gap-2"
              title="OBS Studio v5 WebSocket Switcher"
            >
              <Radio className="w-4 h-4 text-sky-400" />
              <span>OBS SWITCHER · WS V5</span>
            </span>
            <span className="font-mono text-[11px] text-slate-400 flex items-center gap-2">
              <span
                className="hw-lamp"
                style={{ width: 6, height: 6 }}
                data-on={obsState.connected ? 'green' : undefined}
                aria-hidden="true"
              />
              <span>{wsUrl}</span>
            </span>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div
                className="font-mono text-[10px] text-slate-400 uppercase hw-engraved"
                title={`Program scene pads — ${obsState.connected ? 'live OBS synced' : 'local mode'}`}
              >
                PROGRAM SCENES · {obsState.connected ? 'SYNCED' : 'LOCAL'}
              </div>
              {obsState.connected && (
                <span className="font-mono text-[10px] text-sky-400">
                  PGM: {obsState.activeScene}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {obsState.scenes.map((scene) => {
                const active = obsState.activeScene === scene;
                return (
                  <button
                    key={scene}
                    type="button"
                    onClick={() => handleSceneClick(scene)}
                    title={`Cut to OBS scene: ${scene}`}
                    className={`px-3 py-2.5 rounded border font-mono text-xs text-left transition-all flex items-center justify-between cursor-pointer hw-key ${
                      active
                        ? '!bg-none !border-sky-400 !bg-sky-500/20 !text-white shadow-[0_0_12px_rgba(56,189,248,0.25)]'
                        : ''
                    }`}
                  >
                    <span className="truncate">{scene}</span>
                    <span
                      className="hw-lamp shrink-0"
                      style={{ width: 5, height: 5 }}
                      data-on={active ? 'cyan' : undefined}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* OBS Transport: Record, Studio Mode & Sync A/V */}
          <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
            <button
              type="button"
              disabled={!obsState.connected}
              onClick={() => void obsWsService.toggleRecord()}
              title={`OBS record — ${obsState.telemetry.recording ? 'stop' : 'start'} remote record in OBS Studio`}
              className={`py-2 px-2.5 rounded border font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 hw-key ${
                obsState.telemetry.recording
                  ? '!bg-none !border-rose-400 !bg-rose-600 !text-white animate-pulse'
                  : ''
              }`}
            >
              <Circle className="w-3 h-3 fill-current" />
              {obsState.telemetry.recording ? 'STOP REC' : 'REC SERMON'}
            </button>

            <button
              type="button"
              disabled={!obsState.connected}
              onClick={() => void obsWsService.toggleStudioMode()}
              title="Toggle OBS Studio Mode (preview/program)"
              className={`py-2 px-2.5 rounded border font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 hw-key ${
                obsState.studioModeEnabled
                  ? '!bg-none !border-amber-400/60 !bg-amber-500/25 !text-amber-200'
                  : ''
              }`}
            >
              <ArrowRightLeft className="w-3 h-3" />
              STUDIO: {obsState.studioModeEnabled ? 'ON' : 'OFF'}
            </button>

            <button
              type="button"
              disabled={!obsState.connected}
              onClick={() => void obsWsService.triggerTransition()}
              title="Trigger the OBS preview-to-program transition"
              className="py-2 px-2.5 rounded border border-sky-500/50 text-sky-200 font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 hw-key !bg-none !border-sky-500/50 !bg-sky-500/20 !text-sky-200"
            >
              CUT / TRANSITION
            </button>
          </div>

          {/* OBS Exclusive Audio Isolation + Live OBS Audio Mixer */}
          <div className="p-3 rounded border border-emerald-500/30 bg-[#080F0D] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className="font-mono text-[10px] font-bold text-emerald-300 uppercase flex items-center gap-1.5 hw-engraved !text-emerald-300"
                title="OBS exclusive app-audio lock — mute every OBS input except the designated app feed"
              >
                <Lock className="w-3.5 h-3.5" />
                EXCLUSIVE AUDIO LOCK
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!obsState.connected}
                  onClick={() => void handleSyncAvOffsetToObs()}
                  title={`Sync the ${broadcastDsp.avSyncOffsetMs}ms A/V offset to the designated OBS input`}
                  className="px-2 py-1 rounded border border-sky-500/40 text-sky-200 font-mono text-[10px] font-bold cursor-pointer disabled:opacity-40 hw-key !bg-none !border-sky-500/40 !bg-sky-500/15 !text-sky-200"
                >
                  SYNC {broadcastDsp.avSyncOffsetMs}ms A/V
                </button>
                <button
                  type="button"
                  disabled={!obsState.connected || obsState.audioInputs.length === 0}
                  onClick={() =>
                    exclusiveAudioLock
                      ? setExclusiveAudioLock(false)
                      : void handleEnforceExclusiveObsAudio()
                  }
                  className={`px-2.5 py-1 rounded border font-mono text-[10px] font-bold cursor-pointer disabled:opacity-40 hw-key ${
                    exclusiveAudioLock
                      ? '!bg-none !border-emerald-300 !bg-emerald-500 !text-slate-950'
                      : '!bg-none !border-emerald-400/50 !bg-emerald-500/20 !text-emerald-200'
                  }`}
                  title={exclusiveAudioLock
                    ? 'Exclusive app-audio lock active — only the designated feed is unmuted'
                    : 'Mute all other OBS mics — enforce the exclusive app-audio lock'}
                >
                  {exclusiveAudioLock ? 'LOCK ON' : 'ENGAGE LOCK'}
                </button>
              </div>
            </div>

            {obsState.connected && obsState.audioInputs.length > 0 ? (
              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {obsState.audioInputs.map((inp) => {
                  const isAppFeed = designatedObsInput === inp.inputName;
                  return (
                    <div
                      key={inp.inputName}
                      className={`px-2.5 py-1.5 rounded border flex items-center justify-between gap-2 font-mono text-[10px] ${
                        isAppFeed
                          ? 'border-emerald-400/50 bg-emerald-950/30'
                          : 'border-slate-800 bg-[#06090F]'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <input
                          type="radio"
                          name="designated-obs-feed"
                          checked={isAppFeed}
                          onChange={() => setDesignatedObsInput(inp.inputName)}
                          title="Designate as App Broadcast Feed"
                          aria-label={`Designate ${inp.inputName} as app broadcast feed`}
                          className="accent-emerald-400 cursor-pointer"
                        />
                        <span className="text-white font-semibold truncate">{inp.inputName}</span>
                        {isAppFeed && (
                          <span className="px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[8px] font-bold">
                            APP FEED
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <input
                          type="range"
                          min={-48}
                          max={6}
                          step={0.5}
                          value={inp.volumeDb}
                          onChange={(e) =>
                            void obsWsService.setInputVolumeDb(inp.inputName, parseFloat(e.target.value))
                          }
                          className="w-16 accent-sky-400 cursor-pointer"
                        />
                        <span className="w-11 text-right text-slate-300 tabular-nums">
                          {inp.volumeDb.toFixed(1)}dB
                        </span>
                        <button
                          type="button"
                          onClick={() => void obsWsService.setInputMute(inp.inputName, !inp.muted)}
                          title={`${inp.muted ? 'Unmute' : 'Mute'} OBS input ${inp.inputName}`}
                          className={`px-2 py-0.5 rounded border font-bold cursor-pointer flex items-center gap-1 hw-key ${
                            inp.muted
                              ? '!bg-none !border-red-400 !bg-red-600/80 !text-white'
                              : '!bg-none !border-emerald-400/50 !bg-emerald-500/20 !text-emerald-300'
                          }`}
                        >
                          {inp.muted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                          {inp.muted ? 'MUTED' : 'LIVE'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2 py-2">
                <span
                  className="hw-lamp shrink-0"
                  style={{ width: 5, height: 5 }}
                  aria-hidden="true"
                />
                <span
                  className="font-mono text-[9px] font-bold tracking-wider text-slate-500 uppercase"
                  title="Connect OBS WebSocket above to view & mute all OBS mics/inputs and lock the stream exclusively to this app's audio."
                >
                  WS OFFLINE · LOCK OFF
                </span>
              </div>
            )}
          </div>

          {/* Feedback Loop Guard */}
          <div className="p-3 rounded border border-slate-800 bg-[#090D14] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span
                className="font-mono font-semibold text-slate-200 hw-engraved"
                title="OBS audio monitoring — feedback loop guard"
              >
                AUDIO MONITOR · LOOP GUARD
              </span>
              {obsStatus.audioMonitorMode === 'Monitor Off' ? (
                <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>LOOP SAFE</span>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-400 font-mono text-[11px]">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>LOOP RISK</span>
                </span>
              )}
            </div>
            <select
              value={obsStatus.audioMonitorMode}
              onChange={(e) =>
                onUpdateObs({
                  audioMonitorMode: e.target.value as ObsStatus['audioMonitorMode'],
                })
              }
              aria-label="OBS audio monitoring mode"
              title="Monitor Off recommended — prevents a PA feedback loop"
              className="w-full px-2.5 py-1.5 rounded border border-slate-700 bg-[#121824] text-slate-200 text-xs font-mono"
            >
              <option value="Monitor Off">Monitor Off</option>
              <option value="Monitor Only">Monitor Only</option>
              <option value="Monitor and Output">Monitor and Output</option>
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3 p-2.5 rounded bg-[#070A10] border border-slate-800 font-mono text-xs items-center">
            <div>
              <div className="text-[10px] text-slate-500 hw-engraved">BITRATE</div>
              <div className="text-slate-100 tabular-nums rounded px-1.5 py-0.5 hw-lcd">
                {obsState.telemetry.streaming ? `${obsState.telemetry.bitrateKbps} kbps` : 'IDLE'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 hw-engraved">DROPPED</div>
              <div className="text-emerald-400 tabular-nums rounded px-1.5 py-0.5 hw-lcd">
                {obsState.telemetry.droppedFrames} frames
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSyncCheck}
                title="Re-sync the OBS state snapshot (scenes, inputs, telemetry)"
                className="px-2.5 py-1.5 rounded border text-[11px] text-slate-200 flex items-center gap-1 cursor-pointer hw-key"
              >
                <RefreshCw className="w-3 h-3 text-sky-400" />
                <span>SYNC CHECK</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
