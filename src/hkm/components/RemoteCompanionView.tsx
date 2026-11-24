import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Lock,
  Radio,
  RotateCcw,
  ShieldAlert,
  Sliders,
  Speaker,
  VolumeX,
  Wifi,
  WifiOff,
  CheckCircle2,
} from 'lucide-react';
import type {
  DcaGroupName,
  HardwareDevice,
  InputChannel,
  RemoteAccessConfig,
  SignalTelemetry,
  SpeakerZone,
} from '../types/audio.ts';
import { HARDWARE_CATALOG } from '../data/hardwareCatalog.ts';
import { buildRelayWsUrls } from '../utils/wsUrls.ts';

interface RemoteCompanionViewProps {
  token: string;
  onExitRemote?: () => void;
  /**
   * Fires once when the link dies from a fatal pairing failure (invalid or
   * rotated token, session revoked) so the host app can fall back to the
   * pairing gate. PIN retry errors never trigger this.
   */
  onFatalAuthError?: (message: string) => void;
}

type DcaFilter = 'All' | DcaGroupName;
type ContentTab = 'channels' | 'zones';

const ZONE_ROLE_LABELS: Record<SpeakerZone['role'], string> = {
  'main-lr': 'MAIN L/R',
  center: 'CENTER',
  sub: 'SUB',
  'rear-fill': 'REAR FILL',
  'stage-monitor': 'STAGE MONITOR',
  overflow: 'OVERFLOW',
};

const JACK_SLOT_LABELS: Record<string, string> = {
  'front-lr': 'FRONT L/R',
  'rear-lr': 'REAR L/R',
  'center-lfe': 'CENTER/SUB',
  'side-lr': 'SIDE L/R',
};

/**
 * Parses a persisted jack binding (`${deviceId}::jack::${slot}`, see
 * utils/jackTopology.ts) into a short human label for the zone card chip.
 */
function parseJackSlotLabel(jackId: string): string | null {
  const marker = '::jack::';
  const idx = jackId.indexOf(marker);
  if (idx === -1) return null;
  const slot = jackId.slice(idx + marker.length).trim();
  if (!slot) return null;
  return JACK_SLOT_LABELS[slot] ?? slot.toUpperCase();
}

/** Short tactile confirmation for destructive-ish taps (mute/solo). */
function hapticTap(): void {
  try {
    navigator.vibrate?.(8);
  } catch {
    // vibration unsupported — no-op
  }
}

export const RemoteCompanionView: React.FC<RemoteCompanionViewProps> = ({
  token,
  onExitRemote,
  onFatalAuthError,
}) => {
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'connecting'
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [channels, setChannels] = useState<InputChannel[]>([]);
  const [zones, setZones] = useState<SpeakerZone[]>([]);
  const [contentTab, setContentTab] = useState<ContentTab>('channels');
  const [activeDevice, setActiveDevice] = useState<HardwareDevice>(HARDWARE_CATALOG[0]);
  const [venueLabel, setVenueLabel] = useState('FOH Companion');
  const [inputTrimDb, setInputTrimDb] = useState(0);
  const [emergencyMuted, setEmergencyMuted] = useState(false);
  const [permissions, setPermissions] = useState<
    Pick<
      RemoteAccessConfig,
      'allowGainAdjustment' | 'allowMuteControl' | 'allowMasterTrim'
    >
  >({
    allowGainAdjustment: true,
    allowMuteControl: true,
    allowMasterTrim: true,
  });
  const [liveTelemetry, setLiveTelemetry] = useState<SignalTelemetry | null>(null);
  const [dcaFilter, setDcaFilter] = useState<DcaFilter>('All');
  const [lastMsgAgeLabel, setLastMsgAgeLabel] = useState('--');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastMsgAtRef = useRef<number>(0);
  const onFatalAuthErrorRef = useRef(onFatalAuthError);
  onFatalAuthErrorRef.current = onFatalAuthError;

  // Companion-only service worker (PWA installability). The desktop console
  // never mounts this view, so it never registers a SW.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Connection health ticker: re-labels the last-message age 4x per second.
  // setState with an identical string is a no-op render, so a quiet link
  // costs nothing.
  useEffect(() => {
    const formatAge = () => {
      const last = lastMsgAtRef.current;
      if (!last) {
        setLastMsgAgeLabel('--');
        return;
      }
      const ageMs = Math.max(0, Date.now() - last);
      if (ageMs < 1000) setLastMsgAgeLabel(`${(ageMs / 1000).toFixed(1)}s ago`);
      else if (ageMs < 60000) setLastMsgAgeLabel(`${Math.floor(ageMs / 1000)}s ago`);
      else setLastMsgAgeLabel(`${Math.floor(ageMs / 60000)}m ago`);
    };
    formatAge();
    const id = window.setInterval(formatAge, 250);
    return () => window.clearInterval(id);
  }, []);

  // Screen wake lock while the live link is up: a mixing phone must not
  // dim/lock mid-service. Re-acquired when the tab becomes visible again
  // (the platform auto-releases sentinels on hide). No-op where unsupported.
  useEffect(() => {
    if (wsStatus !== 'connected' || typeof navigator === 'undefined' || !navigator.wakeLock) {
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
      } catch {
        // denied or unsupported — no-op
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (sentinel) {
        sentinel.release().catch(() => {});
        sentinel = null;
      }
    };
  }, [wsStatus]);

  useEffect(() => {
    let closedByUser = false;
    // Exponential backoff (2s → 10s cap) for reconnect attempts.
    let reconnectAttempts = 0;

    const connect = () => {
      setWsStatus('connecting');
      setAuthError(null);
      const deviceLabel = /iPhone|iPad|Android/i.test(navigator.userAgent)
        ? navigator.platform || 'Mobile FOH'
        : 'Remote Companion Browser';
      // Transport ladder (see utils/wsUrls.ts): same-origin gateway URL first,
      // direct ws://<host>:3030 fallback for LAN consoles without a gateway.
      // (buildRelayWsUrls encodes params itself — pass the raw label.)
      const urls = buildRelayWsUrls({
        role: 'mobile',
        token,
        device: deviceLabel,
      });

      const handleSocketMessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(String(event.data));
          lastMsgAtRef.current = Date.now();
          if (msg.type === 'auth:pin-required') {
            setPinRequired(true);
            return;
          }
          if (msg.type === 'auth:ok') {
            setPinRequired(false);
            setAuthError(null);
            return;
          }
          if (msg.type === 'auth:error') {
            setAuthError(msg.error || 'Pairing rejected.');
            return;
          }
          if (msg.type === 'state:full' && msg.state) {
            const st = msg.state;
            setPinRequired(false);
            if (Array.isArray(st.channels)) setChannels(st.channels);
            if (Array.isArray(st.zones)) setZones(st.zones);
            if (st.venue) {
              setVenueLabel(`${st.venue.venueName ?? 'FOH'} · ${st.venue.roomName ?? 'Sanctuary'}`);
              const dev =
                HARDWARE_CATALOG.find((d) => d.id === st.venue.activeDeviceId) ??
                HARDWARE_CATALOG[0];
              setActiveDevice(dev);
            }
            if (st.dsp && typeof st.dsp.inputTrimDb === 'number') {
              setInputTrimDb(st.dsp.inputTrimDb);
            }
            if (typeof st.emergencyMuted === 'boolean') {
              setEmergencyMuted(st.emergencyMuted);
            }
            if (st.remoteAccess) {
              setPermissions({
                allowGainAdjustment: Boolean(st.remoteAccess.allowGainAdjustment),
                allowMuteControl: Boolean(st.remoteAccess.allowMuteControl),
                allowMasterTrim: Boolean(st.remoteAccess.allowMasterTrim),
              });
            }
            return;
          }
          if (msg.type === 'state:sync') {
            if (Array.isArray(msg.channels)) setChannels(msg.channels);
            if (Array.isArray(msg.zones)) setZones(msg.zones);
            if (msg.dsp && typeof msg.dsp.inputTrimDb === 'number') {
              setInputTrimDb(msg.dsp.inputTrimDb);
            }
            if (typeof msg.emergencyMuted === 'boolean') {
              setEmergencyMuted(msg.emergencyMuted);
            }
            return;
          }
          if (msg.type === 'channel:patch' && msg.channelId && msg.patch) {
            setChannels((prev) =>
              prev.map((ch) => (ch.id === msg.channelId ? { ...ch, ...msg.patch } : ch))
            );
            return;
          }
          if (msg.type === 'zone:patch' && msg.zoneId && msg.patch) {
            setZones((prev) =>
              prev.map((z) => (z.id === msg.zoneId ? { ...z, ...msg.patch } : z))
            );
            return;
          }
          if (msg.type === 'master:patch') {
            if (typeof msg.inputTrimDb === 'number') setInputTrimDb(msg.inputTrimDb);
            if (typeof msg.emergencyMuted === 'boolean') setEmergencyMuted(msg.emergencyMuted);
            return;
          }
          if (msg.type === 'remote:config' && msg.remoteAccess) {
            setPermissions({
              allowGainAdjustment: Boolean(msg.remoteAccess.allowGainAdjustment),
              allowMuteControl: Boolean(msg.remoteAccess.allowMuteControl),
              allowMasterTrim: Boolean(msg.remoteAccess.allowMasterTrim),
            });
            return;
          }
          if (msg.type === 'telemetry:frame' && msg.telemetry) {
            setLiveTelemetry(msg.telemetry);
          }
        } catch {
          // ignore malformed packet
        }
      };

      const openSocket = (urlIndex: number) => {
        const socket = new WebSocket(urls[urlIndex]);
        wsRef.current = socket;
        let sawMessage = false;
        let opened = false;
        let advanced = false;

        // Open-timeout guard: a direct LAN hit on the Next.js origin never
        // answers the /ws upgrade (no close frame either — it just hangs), so
        // the primary transport is abandoned after 2.5 s and the direct
        // :3030 relay URL takes over.
        const openTimer = window.setTimeout(() => {
          if (!opened && !advanced) {
            advanced = true;
            try {
              socket.close();
            } catch {
              // already closed
            }
          }
        }, 2500);

        socket.onopen = () => {
          opened = true;
          window.clearTimeout(openTimer);
          reconnectAttempts = 0;
          setWsStatus('connected');
        };

        socket.onmessage = (event) => {
          sawMessage = true;
          handleSocketMessage(event);
        };

        socket.onclose = (ev) => {
          window.clearTimeout(openTimer);
          if (wsRef.current === socket) wsRef.current = null;
          if (ev.code === 4001 || ev.code === 4002 || ev.code === 4003) {
            setWsStatus('error');
            const fatalMessage = ev.reason || 'Remote session closed by FOH console.';
            setAuthError(fatalMessage);
            onFatalAuthErrorRef.current?.(fatalMessage);
            return;
          }
          // Primary URL died before opening (hung upgrade / unreachable) —
          // retry once immediately on the direct :3030 transport.
          if (urlIndex === 0 && !opened && !closedByUser) {
            openSocket(1);
            return;
          }
          setWsStatus('disconnected');
          if (!closedByUser) {
            const delay = Math.min(10000, 2000 * Math.pow(2, reconnectAttempts));
            reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
            reconnectTimerRef.current = window.setTimeout(connect, delay);
          }
        };

        socket.onerror = () => {
          if (!opened) setWsStatus('error');
        };
      };

      openSocket(0);
    };

    // App-level keepalive: refreshes the relay's lastSeenAt and the link
    // health ticker while the socket is otherwise idle.
    const pingTimer = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);

    connect();

    return () => {
      closedByUser = true;
      window.clearInterval(pingTimer);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [token]);

  const sendChannelPatch = (channelId: string, patch: Partial<InputChannel>) => {
    setChannels((prev) => prev.map((ch) => (ch.id === channelId ? { ...ch, ...patch } : ch)));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'channel:patch', channelId, patch }));
    }
  };

  const sendZonePatch = (zoneId: string, patch: Partial<SpeakerZone>) => {
    setZones((prev) => prev.map((z) => (z.id === zoneId ? { ...z, ...patch } : z)));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'zone:patch', zoneId, patch }));
    }
  };

  const sendMasterPatch = (patch: { inputTrimDb?: number; emergencyMuted?: boolean }) => {
    if (typeof patch.inputTrimDb === 'number') setInputTrimDb(patch.inputTrimDb);
    if (typeof patch.emergencyMuted === 'boolean') setEmergencyMuted(patch.emergencyMuted);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'master:patch', ...patch }));
    }
  };

  const handleSubmitPin = (e: React.FormEvent) => {
    e.preventDefault();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'auth:verify-pin', pin: pinInput.trim() }));
    }
  };

  const filteredChannels = useMemo(
    () =>
      dcaFilter === 'All'
        ? channels
        : channels.filter((ch) => ch.dcaGroup === dcaFilter),
    [channels, dcaFilter]
  );

  if (pinRequired) {
    return (
      <div className="min-h-screen bg-[#080B10] text-slate-100 flex items-center justify-center p-4">
        <form
          onSubmit={handleSubmitPin}
          className="w-full max-w-sm rounded-xl border border-slate-800 bg-[#0E1524] p-6 space-y-4"
        >
          <div className="flex items-center gap-2.5">
            <Lock className="w-5 h-5 text-sky-400" />
            <h1 className="font-display text-lg font-semibold text-white">
              FOH Companion PIN Required
            </h1>
          </div>
          <p className="text-xs text-slate-400">
            Enter the 4-digit security PIN displayed in Hardware &amp; Diagnostics → Remote Access.
          </p>
          <input
            type="password"
            inputMode="numeric"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            placeholder="Enter PIN..."
            className="w-full h-11 px-3 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-center text-lg tracking-widest text-white focus:outline-none focus:border-sky-400"
          />
          {authError && <div className="text-xs text-red-400 font-mono">{authError}</div>}
          <button
            type="submit"
            className="w-full h-11 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-mono text-xs font-semibold uppercase"
          >
            Unlock Remote Console
          </button>
          {onExitRemote && (
            <button
              type="button"
              onClick={onExitRemote}
              className="w-full h-10 rounded-lg border border-slate-700 text-slate-300 font-mono text-xs"
            >
              Return to Desktop Console
            </button>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080B10] text-slate-100 flex flex-col">
      {/* Sticky Compact Mobile FOH Header (safe-area aware for notched phones) */}
      <header
        className="sticky top-0 z-20 border-b border-slate-800 bg-[#0B101B]/95 backdrop-blur-sm px-4 py-2.5 flex items-center justify-between gap-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.625rem)' }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-sky-400 shrink-0" />
            <span className="font-display text-sm font-semibold text-white truncate">
              FOH Remote Companion
            </span>
          </div>
          <div className="font-mono text-[11px] text-slate-400 truncate">
            {venueLabel} · {activeDevice.manufacturer} {activeDevice.model}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`px-2 py-1 rounded border font-mono text-[10px] font-semibold flex items-center gap-1 ${
              wsStatus === 'connected'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/40 bg-red-500/10 text-red-300'
            }`}
          >
            {wsStatus === 'connected' ? (
              <Wifi className="w-3 h-3" />
            ) : (
              <WifiOff className="w-3 h-3" />
            )}
            <span>{wsStatus.toUpperCase()}</span>
          </span>
          {onExitRemote && (
            <button
              type="button"
              onClick={onExitRemote}
              className="h-9 px-2.5 rounded border border-slate-700 bg-[#121824] font-mono text-[11px] text-slate-200 whitespace-nowrap"
            >
              Desktop UI
            </button>
          )}
        </div>
      </header>

      <main
        className="flex-1 p-3 sm:p-4 max-w-4xl w-full mx-auto space-y-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        {authError && (
          <div className="p-3 rounded-lg border border-red-500/40 bg-red-950/40 text-xs font-mono text-red-200">
            {authError}
          </div>
        )}

        {/* Hardware Capability & Live Bus Telemetry Strip */}
        <div className="rounded-lg border border-slate-800 bg-[#0E1524] p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="font-mono text-[11px] text-slate-400">
              {activeDevice.capabilities.perChannelFaderControl
                ? 'Hardware-Linked Fader & Preamp Sync Active'
                : 'Software DSP Return Sync (Physical mixer faders remain manual)'}
            </div>
            <div className="font-mono text-xs text-slate-200 tabular-nums flex flex-wrap items-center gap-3">
              <span>
                ENGINE:{' '}
                <strong className={liveTelemetry?.isRunning ? 'text-emerald-400' : 'text-slate-400'}>
                  {liveTelemetry?.isRunning ? 'LIVE' : 'STANDBY'}
                </strong>
              </span>
              <span>
                L/R:{' '}
                <strong className="text-sky-300">
                  {liveTelemetry?.isRunning
                    ? `${liveTelemetry.postLRmsDb.toFixed(1)} / ${liveTelemetry.postRRmsDb.toFixed(1)} dBFS`
                    : '--'}
                </strong>
              </span>
              <span>
                LUFS:{' '}
                <strong className="text-slate-100">
                  {liveTelemetry?.isRunning ? `${liveTelemetry.estimatedLufs.toFixed(1)}` : '--'}
                </strong>
              </span>
            </div>
          </div>

          {permissions.allowMasterTrim && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-slate-800 bg-[#070A10]">
                <span className="font-mono text-[10px] text-slate-400">MASTER TRIM</span>
                <button
                  type="button"
                  onClick={() => sendMasterPatch({ inputTrimDb: Math.max(-18, Number((inputTrimDb - 0.5).toFixed(1))) })}
                  className="w-8 h-8 rounded bg-[#162138] text-slate-100 font-mono text-sm"
                  aria-label="Decrease master trim"
                >
                  -
                </button>
                <span className="font-mono text-xs font-bold text-sky-300 w-14 text-center tabular-nums">
                  {inputTrimDb > 0 ? `+${inputTrimDb.toFixed(1)}` : inputTrimDb.toFixed(1)} dB
                </span>
                <button
                  type="button"
                  onClick={() => sendMasterPatch({ inputTrimDb: Math.min(12, Number((inputTrimDb + 0.5).toFixed(1))) })}
                  className="w-8 h-8 rounded bg-[#162138] text-slate-100 font-mono text-sm"
                  aria-label="Increase master trim"
                >
                  +
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  hapticTap();
                  sendMasterPatch({ emergencyMuted: !emergencyMuted });
                }}
                className={`h-11 px-3 rounded font-mono text-xs font-bold flex items-center gap-1.5 border ${
                  emergencyMuted
                    ? 'bg-red-600 border-red-300 text-white'
                    : 'border-red-500/50 bg-red-950/40 text-red-300'
                }`}
              >
                <ShieldAlert className="w-4 h-4" />
                <span>{emergencyMuted ? 'UNMUTE PA' : 'MUTE PA'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Zones / Channels segmented view toggle */}
        <div
          role="tablist"
          aria-label="Companion content view"
          className="grid grid-cols-2 gap-1 p-1 rounded-lg border border-slate-800 bg-[#0E1524]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={contentTab === 'zones'}
            onClick={() => setContentTab('zones')}
            className={`h-11 rounded-md font-mono text-xs font-bold border flex items-center justify-center gap-1.5 ${
              contentTab === 'zones'
                ? 'border-teal-400 bg-teal-500/20 text-white'
                : 'border-transparent text-slate-400'
            }`}
          >
            <Speaker className="w-3.5 h-3.5" />
            <span>ZONES ({zones.length})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={contentTab === 'channels'}
            onClick={() => setContentTab('channels')}
            className={`h-11 rounded-md font-mono text-xs font-bold border flex items-center justify-center gap-1.5 ${
              contentTab === 'channels'
                ? 'border-sky-400 bg-sky-500/20 text-white'
                : 'border-transparent text-slate-400'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>CHANNELS ({channels.length})</span>
          </button>
        </div>

        {contentTab === 'zones' ? (
          /* Speaker Zone Control Cards */
          zones.length === 0 ? (
            <div className="p-8 rounded-lg border border-slate-800 bg-[#0E1524] text-center font-mono text-xs text-slate-400">
              Waiting for speaker zone sync from FOH host...
            </div>
          ) : (
            <div className="space-y-2.5">
              {zones.map((zone) => {
                const jackLabel = zone.outputJackId
                  ? parseJackSlotLabel(zone.outputJackId)
                  : null;
                return (
                  <section
                    key={zone.id}
                    aria-label={`${zone.name} zone control`}
                    className={`rounded-lg border p-3.5 space-y-3 ${
                      zone.mute
                        ? 'border-red-500/40 bg-[#140E13]'
                        : 'border-slate-800 bg-[#0E1524]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Speaker className="w-3.5 h-3.5 text-teal-300 shrink-0" />
                          <span className="text-sm font-semibold text-white truncate">
                            {zone.name}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 flex items-center gap-1.5 flex-wrap mt-0.5">
                          <span>{ZONE_ROLE_LABELS[zone.role] ?? zone.role.toUpperCase()}</span>
                          {jackLabel && (
                            <span className="px-1.5 py-0.5 rounded border border-teal-500/40 bg-teal-500/10 text-teal-300 text-[10px]">
                              {jackLabel}
                            </span>
                          )}
                        </div>
                      </div>

                      {permissions.allowMuteControl && (
                        <button
                          type="button"
                          onClick={() => {
                            hapticTap();
                            sendZonePatch(zone.id, { mute: !zone.mute });
                          }}
                          className={`h-11 min-w-[72px] px-3 rounded-lg font-mono text-xs font-bold border flex items-center justify-center gap-1 shrink-0 ${
                            zone.mute
                              ? 'bg-red-600 border-red-300 text-white'
                              : 'border-slate-700 bg-[#070A10] text-slate-300'
                          }`}
                        >
                          {zone.mute ? (
                            <VolumeX className="w-3.5 h-3.5" />
                          ) : (
                            <Radio className="w-3.5 h-3.5" />
                          )}
                          <span>{zone.mute ? 'MUTED' : 'ON'}</span>
                        </button>
                      )}
                    </div>

                    {permissions.allowMasterTrim ? (
                      <>
                        {/* Zone Level Fader */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between font-mono text-xs">
                            <span className="text-slate-400">ZONE LEVEL</span>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-white tabular-nums">
                                {zone.levelDb > 0
                                  ? `+${zone.levelDb.toFixed(1)}`
                                  : zone.levelDb.toFixed(1)}{' '}
                                dB
                              </span>
                              <button
                                type="button"
                                onClick={() => sendZonePatch(zone.id, { levelDb: 0 })}
                                className="px-2 py-1 rounded border border-slate-700 bg-[#070A10] text-[10px] text-sky-300 flex items-center gap-1"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>0 dB</span>
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                sendZonePatch(zone.id, {
                                  levelDb: Math.max(-24, Number((zone.levelDb - 0.5).toFixed(1))),
                                })
                              }
                              className="w-11 h-11 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-base text-slate-200 shrink-0"
                              aria-label={`Decrease ${zone.name} level`}
                            >
                              -
                            </button>
                            <input
                              type="range"
                              min={-24}
                              max={12}
                              step={0.5}
                              value={zone.levelDb}
                              onChange={(e) =>
                                sendZonePatch(zone.id, { levelDb: Number(e.target.value) })
                              }
                              className="studio-slider flex-1 h-11"
                              aria-label={`${zone.name} zone level`}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                sendZonePatch(zone.id, {
                                  levelDb: Math.min(12, Number((zone.levelDb + 0.5).toFixed(1))),
                                })
                              }
                              className="w-11 h-11 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-base text-slate-200 shrink-0"
                              aria-label={`Increase ${zone.name} level`}
                            >
                              +
                            </button>
                          </div>
                        </div>

                        {/* Zone Delay (read-only — alignment is set from the FOH zone designer) */}
                        <div className="flex items-center justify-between font-mono text-[11px] pt-1.5 border-t border-slate-800/80">
                          <span className="text-slate-400">DELAY</span>
                          <span className="px-2 py-1 rounded border border-slate-800 bg-[#070A10] text-slate-300 tabular-nums">
                            {zone.delayMs.toFixed(1)} ms
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center gap-2 font-mono text-[11px] text-slate-500 pt-1.5 border-t border-slate-800/80">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>Level control disabled by FOH</span>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )
        ) : (
          <>
            {/* DCA Filter Strip */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {(
                [
                  'All',
                  'DCA 4 · Speech',
                  'DCA 1 · Vox',
                  'DCA 2 · Band',
                  'DCA 3 · Choir',
                ] as DcaFilter[]
              ).map((grp) => (
                <button
                  key={grp}
                  type="button"
                  onClick={() => setDcaFilter(grp)}
                  className={`h-10 px-3 rounded-lg font-mono text-xs font-semibold whitespace-nowrap shrink-0 border ${
                    dcaFilter === grp
                      ? 'border-sky-400 bg-sky-500/20 text-white'
                      : 'border-slate-800 bg-[#0E1524] text-slate-400'
                  }`}
                >
                  {grp === 'All' ? `All Channels (${channels.length})` : grp}
                </button>
              ))}
            </div>

            {/* Touch-Optimized Channel Fader & Preamp Gain Cards */}
            {filteredChannels.length === 0 ? (
              <div className="p-8 rounded-lg border border-slate-800 bg-[#0E1524] text-center font-mono text-xs text-slate-400">
                Waiting for channel sync from FOH host...
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredChannels.map((ch) => (
                  <div
                    key={ch.id}
                    className={`rounded-lg border p-3.5 space-y-3 ${
                      ch.mute
                        ? 'border-red-500/40 bg-[#140E13]'
                        : ch.solo
                          ? 'border-amber-400/50 bg-[#15130D]'
                          : 'border-slate-800 bg-[#0E1524]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-sky-400 tabular-nums">
                            CH {String(ch.index).padStart(2, '0')}
                          </span>
                          <span className="text-sm font-semibold text-white truncate">
                            {ch.name}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-400">
                          {ch.role} · {ch.dcaGroup} · {ch.phantom48v ? '+48V' : 'No Phantom'}
                        </div>
                      </div>

                      {permissions.allowMuteControl && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              hapticTap();
                              sendChannelPatch(ch.id, { solo: !ch.solo });
                            }}
                            className={`h-11 min-w-[54px] px-3 rounded-lg font-mono text-xs font-bold border ${
                              ch.solo
                                ? 'bg-amber-500 border-amber-300 text-slate-950'
                                : 'border-slate-700 bg-[#070A10] text-slate-300'
                            }`}
                          >
                            SOLO
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              hapticTap();
                              sendChannelPatch(ch.id, { mute: !ch.mute });
                            }}
                            className={`h-11 min-w-[64px] px-3 rounded-lg font-mono text-xs font-bold border flex items-center justify-center gap-1 ${
                              ch.mute
                                ? 'bg-red-600 border-red-300 text-white'
                                : 'border-slate-700 bg-[#070A10] text-slate-300'
                            }`}
                          >
                            {ch.mute ? <VolumeX className="w-3.5 h-3.5" /> : <Radio className="w-3.5 h-3.5" />}
                            <span>{ch.mute ? 'MUTED' : 'ON'}</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Live Channel Input VU Meter */}
                    {(() => {
                      const chTel = liveTelemetry?.isRunning
                        ? liveTelemetry.channelLevels?.[ch.index - 1]
                        : undefined;
                      const chDb =
                        chTel && !ch.mute
                          ? Math.max(-64, Math.min(-0.2, chTel.rmsDb + ch.faderDb * 0.5))
                          : -96;
                      const pct =
                        liveTelemetry?.isRunning && !ch.mute && chTel && chDb > -63.5
                          ? Math.max(0, Math.min(100, ((chDb + 64) / 64) * 100))
                          : 0;
                      return (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded-xs bg-[#070A10] border border-slate-800 overflow-hidden">
                            <div
                              className={`h-full transition-[width] duration-75 ${
                                chDb > -3 ? 'bg-red-500' : chDb > -14 ? 'bg-amber-400' : 'bg-emerald-400'
                              }`}
                              style={{ width: `${pct.toFixed(1)}%` }}
                            />
                          </div>
                          <span className="font-mono text-[10px] text-slate-400 w-14 text-right tabular-nums">
                            {ch.mute
                              ? 'MUTE'
                              : liveTelemetry?.isRunning && chTel
                                ? `${chDb.toFixed(1)} dB`
                                : '--'}
                          </span>
                        </div>
                      );
                    })()}

                    {/* Fader Level Slider */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between font-mono text-xs">
                        <span className="text-slate-400">FADER LEVEL</span>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white tabular-nums">
                            {ch.faderDb > 0 ? `+${ch.faderDb.toFixed(1)}` : ch.faderDb.toFixed(1)} dB
                          </span>
                          <button
                            type="button"
                            onClick={() => sendChannelPatch(ch.id, { faderDb: 0 })}
                            className="px-2 py-1 rounded border border-slate-700 bg-[#070A10] text-[10px] text-sky-300 flex items-center gap-1"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>0 dB</span>
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            sendChannelPatch(ch.id, {
                              faderDb: Math.max(-48, Number((ch.faderDb - 1).toFixed(1))),
                            })
                          }
                          className="w-11 h-11 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-base text-slate-200 shrink-0"
                          aria-label={`${ch.name} decrease fader`}
                        >
                          -
                        </button>
                        <input
                          type="range"
                          min={-48}
                          max={10}
                          step={0.5}
                          value={ch.faderDb}
                          onChange={(e) =>
                            sendChannelPatch(ch.id, { faderDb: Number(e.target.value) })
                          }
                          className="studio-slider flex-1 h-11"
                          aria-label={`${ch.name} Fader Level`}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            sendChannelPatch(ch.id, {
                              faderDb: Math.min(10, Number((ch.faderDb + 1).toFixed(1))),
                            })
                          }
                          className="w-11 h-11 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-base text-slate-200 shrink-0"
                          aria-label={`${ch.name} increase fader`}
                        >
                          +
                        </button>
                      </div>
                    </div>

                    {/* Preamp Gain Control */}
                    {permissions.allowGainAdjustment && (
                      <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
                        <div className="flex items-center justify-between font-mono text-xs">
                          <span className="text-slate-400">PREAMP GAIN</span>
                          <span className="font-bold text-amber-300 tabular-nums">
                            +{ch.gainDb} dB
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              sendChannelPatch(ch.id, { gainDb: Math.max(0, ch.gainDb - 1) })
                            }
                            className="w-11 h-11 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-base text-slate-200 shrink-0"
                            aria-label={`${ch.name} decrease preamp gain`}
                          >
                            -
                          </button>
                          <input
                            type="range"
                            min={0}
                            max={60}
                            step={1}
                            value={ch.gainDb}
                            onChange={(e) =>
                              sendChannelPatch(ch.id, { gainDb: Number(e.target.value) })
                            }
                            className="studio-slider flex-1 h-11"
                            aria-label={`${ch.name} Preamp Gain`}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              sendChannelPatch(ch.id, { gainDb: Math.min(60, ch.gainDb + 1) })
                            }
                            className="w-11 h-11 rounded-lg border border-slate-700 bg-[#070A10] font-mono text-base text-slate-200 shrink-0"
                            aria-label={`${ch.name} increase preamp gain`}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Link Health Footer */}
        <div className="py-3 text-center font-mono text-[11px] text-slate-500 flex items-center justify-center gap-1.5 flex-wrap px-1">
          <CheckCircle2
            className={`w-3.5 h-3.5 ${
              wsStatus === 'connected' ? 'text-emerald-400' : 'text-slate-600'
            }`}
          />
          <span>Synced via FOH companion link</span>
          <span className="text-slate-700" aria-hidden="true">
            ·
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                wsStatus === 'connected'
                  ? 'bg-emerald-400 animate-pulse'
                  : wsStatus === 'connecting'
                    ? 'bg-amber-400'
                    : 'bg-red-400'
              }`}
            />
            <span>LIVE SYNC · WS</span>
          </span>
          <span className="text-slate-700" aria-hidden="true">
            ·
          </span>
          <span className="tabular-nums">
            {wsStatus === 'connected' ? lastMsgAgeLabel : wsStatus.toUpperCase()}
          </span>
        </div>
      </main>
    </div>
  );
};
