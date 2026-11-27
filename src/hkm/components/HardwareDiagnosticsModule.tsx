import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  Cpu,
  Puzzle,
  Layers,
  ShieldAlert,
  CheckCircle2,
  Plus,
  Trash2,
  Smartphone,
  QrCode,
  Copy,
  Check,
  RefreshCw,
  Lock,
  ExternalLink,
  Wifi,
  UserX,
  Usb,
  Radar,
  Download,
} from 'lucide-react';
import type {
  AudioSourceSimulation,
  AuditEvent,
  DetectedHardwareEndpoint,
  DriverBackend,
  HardwareDevice,
  NetworkInterfaceInfo,
  PlatformTarget,
  RemoteAccessConfig,
  RemoteClientSession,
  SignalTelemetry,
} from '../types/audio.ts';
import type { LoadedPluginRecord } from '../plugins/pluginManager.ts';
import {
  PLUGIN_SDK_CONTRACT_SNIPPET,
  SAMPLE_CUSTOM_DSP_PLUGIN,
  SAMPLE_CUSTOM_HARDWARE_PLUGIN,
} from '../plugins/pluginManager.ts';
import { calculateRoundTripLatencyMs } from '../utils/camillaDsp.ts';
import type {
  ApoSystemStatus,
  DesktopAudioSession,
  DesktopAudioStatus,
  DesktopSourceIsolationStatus,
} from '../utils/nativeDesktopAudio.ts';
import type {
  SpecializedDesktopInterface,
  SystemAudioBridgeState,
  SystemAudioCaptureMethod,
} from '../audio/systemAudioBridge.ts';
import { ArcGauge, ConsolePushButton } from './StudioControls.tsx';
import { openHelpTopic } from './HelpDeskModule.tsx';
import {
  getDiagEvents,
  getDiagnosticsReport,
  subscribeDiagEvents,
  type DiagEvent,
} from '../utils/diagnosticsLog.ts';

/**
 * Support Log panel — live view of the session's flight recorder with a
 * one-click "Copy Support Log" (full report: version, platform, uptime and
 * every recorded event). Rendered inside the WATCHDOG tab.
 */
const SupportLogPanel: React.FC = () => {
  const [events, setEvents] = useState<readonly DiagEvent[]>(() => getDiagEvents());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeDiagEvents(() => {
      setEvents(getDiagEvents());
    });
    return unsubscribe;
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getDiagnosticsReport('support log'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied — the log is still visible in the panel itself.
    }
  };

  const errorCount = events.filter((e) => e.level === 'error').length;
  const warnCount = events.filter((e) => e.level === 'warn').length;

  return (
    <div className="rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="font-mono text-xs font-semibold text-white uppercase flex items-center gap-2 hw-engraved">
          Support Log
          <span
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
              errorCount > 0
                ? 'bg-red-500/15 border-red-500/50 text-red-300'
                : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
            }`}
          >
            {errorCount > 0 ? `${errorCount} ERRORS` : 'CLEAN'}
          </span>
          {warnCount > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold border bg-amber-500/15 border-amber-500/50 text-amber-300">
              {warnCount} WARN
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy Support Log — full report with app version, platform, uptime and every recorded event"
          className="px-2.5 py-1 rounded text-[10px] font-bold flex items-center gap-1.5 cursor-pointer hw-key !text-sky-200"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'COPIED' : 'COPY LOG'}
        </button>
      </div>

      <div
        className="max-h-64 overflow-y-auto font-mono text-[10.5px] leading-relaxed divide-y divide-slate-800/60"
        aria-label="Session support log events"
      >
        {events.length === 0 ? (
          <div
            className="py-3 flex items-center gap-2 font-mono text-[10px] font-bold tracking-wider text-slate-500"
            title="No events recorded this session — the console has not hit any errors, warnings or notable system events since launch."
          >
            <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
            NO EVENTS · SESSION
          </div>
        ) : (
          [...events].reverse().map((e, i) => (
            <div key={`${e.ts}-${i}`} className="py-1.5 flex items-start gap-2">
              <span className="text-slate-600 shrink-0 tabular-nums">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              <span
                className={`shrink-0 font-bold w-10 ${
                  e.level === 'error'
                    ? 'text-red-400'
                    : e.level === 'warn'
                      ? 'text-amber-400'
                      : 'text-sky-400'
                }`}
              >
                {e.level.toUpperCase()}
              </span>
              <span className="text-slate-500 shrink-0">[{e.source}]</span>
              <span className={e.level === 'error' ? 'text-red-200' : 'text-slate-300'}>
                {e.message}
              </span>
            </div>
          ))
        )}
      </div>
      <div
        className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-slate-800 bg-[#070A10] font-mono text-[9px] font-bold tracking-wider text-slate-500 hw-engraved"
        title="The log is kept in memory for this session only (last 250 events). Copy Support Log includes the app version, platform and uptime — paste it when reporting an issue."
      >
        SESSION ONLY · 250 EVT MAX
      </div>
    </div>
  );
};


interface HardwareDiagnosticsModuleProps {
  devices: HardwareDevice[];
  desktopBuild?: boolean;
  activeDevice: HardwareDevice;
  onSelectDevice: (device: HardwareDevice) => void;
  platform: PlatformTarget;
  onSelectPlatform: (p: PlatformTarget) => void;
  driver: DriverBackend;
  onSelectDriver: (d: DriverBackend) => void;
  sampleRate: number;
  onSelectSampleRate: (sr: number) => void;
  bufferSize: number;
  onSelectBufferSize: (bs: number) => void;
  plugins: LoadedPluginRecord[];
  onTogglePlugin: (id: string) => void;
  onLoadCustomPlugin: (jsonText: string) => { ok: boolean; error?: string };
  onUnloadPlugin: (id: string) => void;
  telemetry: SignalTelemetry;
  systemCpuPercent: number | null;
  auditEvents: AuditEvent[];
  remoteAccess: RemoteAccessConfig;
  remoteClients: RemoteClientSession[];
  lanInterfaces: NetworkInterfaceInfo[];
  onUpdateRemoteAccess: (patch: Partial<RemoteAccessConfig>) => void;
  onRotateRemoteToken: () => void;
  onDisconnectRemoteClient: (clientId: string) => void;
  onOpenRemoteCompanion: (token: string) => void;
  detectedEndpoints: DetectedHardwareEndpoint[];
  scanningHardware: boolean;
  onScanHardware: (requestBrowserPermission?: boolean) => void;
  onBindDetectedEndpoint: (endpoint: DetectedHardwareEndpoint) => void;
  onClearHardwareCache?: () => void;
  audioSource?: AudioSourceSimulation;
  onSelectAudioSource?: (src: AudioSourceSimulation) => void;
  engineRunning?: boolean;
  onToggleEngine?: () => void;
  desktopAudioStatus?: DesktopAudioStatus | null;
  desktopAudioSessions?: DesktopAudioSession[];
  desktopSourceIsolationStatus?: DesktopSourceIsolationStatus | null;
  apoStatus?: ApoSystemStatus | null;
  singleSpeakerMode?: boolean;
  apoBusy?: boolean;
  apoMessage?: { tone: 'success' | 'error' | 'info'; text: string } | null;
  onRefreshDesktopAudio?: () => void;
  onToggleSingleSpeakerMode?: (enabled: boolean, endpointId?: string) => void;
  onInstallApo?: (endpointId: string) => void;
  onUninstallApo?: (endpointId: string) => void;
  onEnableBrowserDspSpeakers?: () => void;
  onOpenWindowsSoundMixer?: () => void;
  desktopBridgeState?: SystemAudioBridgeState;
  specializedDesktopInputs?: SpecializedDesktopInterface[];
  onSelectDesktopCaptureMethod?: (
    method: SystemAudioCaptureMethod,
    autoStartOrRestart?: boolean
  ) => void;
  onSelectSpecializedDesktopDevice?: (
    device: { deviceId: string | null; label?: string | null; groupId?: string | null },
    autoStartOrRestart?: boolean
  ) => void;
}

const PLATFORM_SPECS: Record<
  PlatformTarget,
  {
    title: string;
    role: string;
    backends: DriverBackend[];
    buildTarget: string;
    binaryResolution: string;
    notes: string;
  }
> = {
  windows: {
    title: 'Windows 10 / 11 (x64)',
    role: 'Primary Desktop Target',
    backends: ['ASIO', 'WASAPI Exclusive', 'WASAPI Shared'],
    buildTarget: 'cargo tauri build --target x86_64-pc-windows-msvc',
    binaryResolution: 'resources/bin/win32-x64/camilladsp.exe (Bundled Tauri Sidecar)',
    notes:
      'ASIO 2.3 provides lowest deterministic latency for interfaces like RME, Focusrite, MOTU, and Yamaha Steinberg USB. WASAPI Exclusive bypasses Windows Audio Engine resampling.',
  },
  macos: {
    title: 'macOS 14+ (Apple Silicon & Intel)',
    role: 'Cross-Platform Target',
    backends: ['CoreAudio'],
    buildTarget: 'cargo tauri build --target universal-apple-darwin',
    binaryResolution: 'Contents/Resources/bin/darwin-universal/camilladsp',
    notes:
      'CoreAudio Aggregate Devices allow combining a stereo USB mixer (e.g. MG16XU) with a UMIK-1 measurement mic without clock drift when Drift Correction is enabled.',
  },
  linux: {
    title: 'Linux (Ubuntu / Debian / Arch)',
    role: 'Cross-Platform Target',
    backends: ['PipeWire', 'ALSA'],
    buildTarget: 'cargo tauri build --target x86_64-unknown-linux-gnu',
    binaryResolution: '/usr/lib/church-audio/bin/camilladsp (AppImage / .deb)',
    notes:
      'USB Audio Class 2.0 (UAC2) kernel support works out-of-the-box with class-compliant interfaces (Behringer UMC1820, MOTU, RME CC mode, Focusrite). PipeWire unifies desktop + pro JACK routing.',
  },
};

export const HardwareDiagnosticsModule: React.FC<HardwareDiagnosticsModuleProps> = ({
  devices,
  desktopBuild = false,
  activeDevice,
  onSelectDevice,
  platform,
  onSelectPlatform,
  driver,
  onSelectDriver,
  sampleRate,
  onSelectSampleRate,
  bufferSize,
  onSelectBufferSize,
  plugins,
  onTogglePlugin,
  onLoadCustomPlugin,
  onUnloadPlugin,
  telemetry,
  systemCpuPercent,
  auditEvents,
  remoteAccess,
  remoteClients,
  lanInterfaces,
  onUpdateRemoteAccess,
  onRotateRemoteToken,
  onDisconnectRemoteClient,
  onOpenRemoteCompanion,
  detectedEndpoints,
  scanningHardware,
  onScanHardware,
  onBindDetectedEndpoint,
  onClearHardwareCache,
  audioSource = 'live-mic',
  onSelectAudioSource,
  engineRunning = false,
  onToggleEngine,
  desktopAudioStatus = null,
  desktopAudioSessions = [],
  desktopSourceIsolationStatus = null,
  apoStatus = null,
  singleSpeakerMode = false,
  apoBusy = false,
  apoMessage = null,
  onRefreshDesktopAudio,
  onToggleSingleSpeakerMode,
  onInstallApo,
  onUninstallApo,
  onEnableBrowserDspSpeakers,
  onOpenWindowsSoundMixer,
  desktopBridgeState,
  specializedDesktopInputs = [],
  onSelectDesktopCaptureMethod,
  onSelectSpecializedDesktopDevice,
}) => {
  const [tab, setTab] = useState<'hardware' | 'remote' | 'plugins' | 'crossplatform' | 'watchdog'>(
    'hardware'
  );
  const [selectedApoEndpointId, setSelectedApoEndpointId] = useState<string>('');
  const [pluginDraft, setPluginDraft] = useState(SAMPLE_CUSTOM_HARDWARE_PLUGIN);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [pluginSuccess, setPluginSuccess] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [appQrDataUrl, setAppQrDataUrl] = useState<string>('');
  const [copiedUrl, setCopiedUrl] = useState(false);

  const latencyMs = calculateRoundTripLatencyMs(bufferSize, sampleRate, driver);
  const platformSpec = PLATFORM_SPECS[platform];

  const baseHostUrl = useMemo(() => {
    if (remoteAccess.lanHostOverride.trim()) {
      return remoteAccess.lanHostOverride.trim().replace(/\/+$/, '');
    }
    const isLocalhost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocalhost && lanInterfaces.length > 0) {
      return lanInterfaces[0].url;
    }
    return window.location.origin;
  }, [remoteAccess.lanHostOverride, lanInterfaces]);

  const pairingUrl = useMemo(() => {
    return `${baseHostUrl}/?mode=remote&token=${encodeURIComponent(remoteAccess.sessionToken)}`;
  }, [baseHostUrl, remoteAccess.sessionToken]);

  // Deep link for the HKM FOH Companion Android app (hkm://pair). Scanning
  // it with the phone camera opens the installed APK straight into the
  // pairing flow — no typing host or token on the phone.
  const appPairingUrl = useMemo(() => {
    try {
      const u = new URL(baseHostUrl);
      const port = u.port || '3000';
      return `hkm://pair?host=${encodeURIComponent(u.hostname)}&port=${port}&token=${encodeURIComponent(
        remoteAccess.sessionToken
      )}`;
    } catch {
      return '';
    }
  }, [baseHostUrl, remoteAccess.sessionToken]);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(pairingUrl, {
      width: 240,
      margin: 2,
      color: {
        dark: '#0B101B',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [pairingUrl]);

  useEffect(() => {
    if (!appPairingUrl) return;
    let active = true;
    QRCode.toDataURL(appPairingUrl, {
      width: 200,
      margin: 2,
      color: {
        dark: '#0B101B',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (active) setAppQrDataUrl(url);
      })
      .catch(() => {
        if (active) setAppQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [appPairingUrl]);

  const handleCopyPairingUrl = () => {
    navigator.clipboard.writeText(pairingUrl);
    setCopiedUrl(true);
    window.setTimeout(() => setCopiedUrl(false), 1800);
  };

  const handleInstallPlugin = () => {
    setPluginError(null);
    setPluginSuccess(null);
    const res = onLoadCustomPlugin(pluginDraft);
    if (!res.ok) {
      setPluginError(res.error || 'PLUGIN MANIFEST REJECTED');
    } else {
      setPluginSuccess('PLUGIN REGISTERED · HOT-LOADED');
    }
  };

  return (
    <div className="space-y-4">
      {/* Studio Rack Header */}
      <div className="rounded-lg border border-slate-800 bg-gradient-to-b from-[#161D29] to-[#0E131C] p-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-8 rounded-xs bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.6)]" />
          <div>
            <h1
              className="font-display text-lg font-semibold text-white tracking-tight"
              title="System Diagnostics, Hardware Adapters & Remote Access"
            >
              SYSTEM DIAGNOSTICS &amp; HARDWARE
            </h1>
            <p
              className="text-[11px] font-mono text-slate-400 hw-engraved"
              title={
                desktopBuild
                  ? 'Windows desktop foundation · Browser-visible devices · Native audio adapters in progress'
                  : 'Tier 1–4 Mixers & Interfaces · QR Mobile FOH Control · Hot-Loadable Plugins · Windows / macOS / Linux'
              }
            >
              {desktopBuild
                ? 'DESKTOP BUILD · BROWSER DEVICES · ADAPTERS WIP'
                : 'TIER 1–4 MIXERS · QR FOH · PLUGINS · WIN / MAC / LINUX'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center p-0.5 rounded bg-[#090D14] border border-slate-800">
          {[
            { id: 'hardware', label: 'HARDWARE', icon: Cpu },
            {
              id: 'remote',
              label: remoteClients.length > 0 ? `REMOTE ACCESS (${remoteClients.length})` : 'REMOTE ACCESS',
              icon: Smartphone,
            },
            { id: 'plugins', label: `PLUGINS (${plugins.length})`, icon: Puzzle },
            { id: 'crossplatform', label: 'OS & DRIVERS', icon: Layers },
            { id: 'watchdog', label: 'WATCHDOG', icon: ShieldAlert },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id as typeof tab)}
                className={`px-3 py-1.5 text-[11px] font-mono font-semibold rounded-xs flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                  tab === item.id
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* OS Driver & Latency Strip */}
      <div className="rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
        <div className="md:col-span-9 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block font-mono text-[10px] text-slate-400 uppercase mb-1 hw-engraved">
              Target OS
            </label>
            <select
              value={platform}
              onChange={(e) => {
                const nextP = e.target.value as PlatformTarget;
                onSelectPlatform(nextP);
                onSelectDriver(PLATFORM_SPECS[nextP].backends[0]);
              }}
              className="w-full h-9 px-2.5 rounded border border-slate-700 bg-[#070A10] text-slate-100 text-xs font-mono"
            >
              <option value="windows">Windows 10/11 (Primary)</option>
              <option value="macos">macOS (CoreAudio)</option>
              <option value="linux">Linux (PipeWire / ALSA)</option>
            </select>
          </div>

          <div>
            <label className="block font-mono text-[10px] text-slate-400 uppercase mb-1">
              Audio Driver
            </label>
            <select
              value={driver}
              onChange={(e) => onSelectDriver(e.target.value as DriverBackend)}
              className="w-full h-9 px-2.5 rounded border border-slate-700 bg-[#070A10] text-slate-100 text-xs font-mono"
            >
              {platformSpec.backends.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-mono text-[10px] text-slate-400 uppercase mb-1">
              Sample Rate
            </label>
            <select
              value={sampleRate}
              onChange={(e) => onSelectSampleRate(Number(e.target.value))}
              className="w-full h-9 px-2.5 rounded border border-slate-700 bg-[#070A10] text-slate-100 text-xs font-mono"
            >
              {activeDevice.sampleRates.map((sr) => (
                <option key={sr} value={sr}>
                  {(sr / 1000).toFixed(1)} kHz
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-mono text-[10px] text-slate-400 uppercase mb-1">
              Buffer Size
            </label>
            <select
              value={bufferSize}
              onChange={(e) => onSelectBufferSize(Number(e.target.value))}
              className="w-full h-9 px-2.5 rounded border border-slate-700 bg-[#070A10] text-slate-100 text-xs font-mono"
            >
              {[64, 128, 256, 512, 1024].map((bs) => (
                <option key={bs} value={bs}>
                  {bs} samples
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="md:col-span-3">
          <ArcGauge
            label="Round-Trip Latency"
            value={latencyMs}
            max={30}
            displayValue={`${latencyMs}ms`}
            sublabel={`${driver} · ${bufferSize} smp`}
            tone={latencyMs < 10 ? 'emerald' : latencyMs < 18 ? 'sky' : 'amber'}
          />
        </div>
      </div>

      {tab === 'remote' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left: QR Pairing Card */}
          <div className="lg:col-span-5 rounded-lg border border-slate-800 bg-[#0D1119] p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                <QrCode className="w-4 h-4 text-sky-400" />
                <span
                  className="font-mono text-xs font-semibold text-white uppercase hw-engraved"
                  title="FOH Mobile Companion QR Pairing"
                >
                  QR PAIRING · FOH MOBILE
                </span>
              </div>
              <button
                type="button"
                onClick={onRotateRemoteToken}
                title="Rotate the remote session token (invalidates old pairing links)"
                className="px-2.5 py-1 rounded font-mono text-[11px] flex items-center gap-1 cursor-pointer hw-key"
              >
                <RefreshCw className="w-3 h-3 text-sky-400" />
                <span>ROTATE TOKEN</span>
              </button>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4">
              <div className="p-3 rounded-lg bg-white border border-slate-300 shrink-0">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Scan to pair mobile FOH companion"
                    className="w-44 h-44 block"
                  />
                ) : (
                  <div className="w-44 h-44 flex items-center justify-center text-xs font-mono text-slate-600">
                    GENERATING QR
                  </div>
                )}
              </div>

              <div className="space-y-2.5 text-xs min-w-0 flex-1">
                <div className="flex flex-wrap gap-1.5 font-mono text-[9px] font-bold tracking-wider">
                  <span
                    className="px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-950/30 text-sky-300"
                    title="Walk the sanctuary with live fader &amp; gain control"
                  >
                    LIVE REMOTE MIX
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-950/30 text-sky-300"
                    title="Scan this QR code on a phone or tablet on the same sanctuary Wi-Fi network (or current session URL) to adjust channel faders, preamp gain, mutes, and master trim in real time over WebSocket."
                  >
                    SAME-LAN WI-FI · WS LIVE SYNC
                  </span>
                </div>
                <div className="font-mono text-[11px] text-sky-400 break-all bg-[#070A10] border border-slate-800 rounded p-2">
                  {pairingUrl}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleCopyPairingUrl}
                    title="Copy the pairing link to the clipboard"
                    className="px-3 py-1.5 rounded font-mono flex items-center gap-1.5 cursor-pointer hw-key"
                  >
                    {copiedUrl ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-sky-400" />
                    )}
                    <span>{copiedUrl ? 'COPIED LINK' : 'COPY LINK'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenRemoteCompanion(remoteAccess.sessionToken)}
                    className="px-3 py-1.5 rounded font-mono font-semibold flex items-center gap-1.5 cursor-pointer hw-key !bg-none !border-sky-400 !bg-sky-600 !text-white"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>OPEN MOBILE VIEW</span>
                  </button>
                </div>
              </div>
            </div>

            {/* LAN Host Selection for Offline Windows Wi-Fi */}
            <div className="pt-2 border-t border-slate-800 space-y-2">
              <label className="block font-mono text-[10px] text-slate-400 uppercase hw-engraved">
                LAN Host / URL Override
              </label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => onUpdateRemoteAccess({ lanHostOverride: '' })}
                  className={`px-2.5 py-1 rounded border text-[10px] font-mono ${
                    !remoteAccess.lanHostOverride
                      ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                      : 'border-slate-800 bg-[#070A10] text-slate-400'
                  }`}
                >
                  AUTO · {window.location.host}
                </button>
                {lanInterfaces.map((iface) => (
                  <button
                    key={`${iface.name}-${iface.address}`}
                    type="button"
                    onClick={() => onUpdateRemoteAccess({ lanHostOverride: iface.url })}
                    className={`px-2.5 py-1 rounded border text-[10px] font-mono ${
                      remoteAccess.lanHostOverride === iface.url
                        ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                        : 'border-slate-800 bg-[#070A10] text-slate-400'
                    }`}
                  >
                    {iface.name}: {iface.address}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={remoteAccess.lanHostOverride}
                onChange={(e) => onUpdateRemoteAccess({ lanHostOverride: e.target.value })}
                placeholder="HOST / IP : PORT"
                className="w-full h-9 px-2.5 rounded border border-slate-700 bg-[#070A10] text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-400"
              />
            </div>

            {/* HKM FOH Companion Android app — real APK + one-scan deep-link pairing */}
            <div className="pt-2 border-t border-slate-800 space-y-2.5">
              <div className="flex items-center gap-2">
                <Download className="w-3.5 h-3.5 text-emerald-400" />
                <span
                  className="font-mono text-[10px] font-semibold text-white uppercase tracking-wider hw-engraved"
                  title="HKM FOH Companion App (Android)"
                >
                  COMPANION APP · ANDROID
                </span>
              </div>
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="p-2 rounded-lg bg-white border border-slate-300 shrink-0">
                  {appQrDataUrl ? (
                    <img
                      src={appQrDataUrl}
                      alt="Scan with the HKM FOH Companion app to pair this console"
                      className="w-32 h-32 block"
                    />
                  ) : (
                    <div className="w-32 h-32 flex items-center justify-center text-[10px] font-mono text-slate-600">
                      GENERATING QR
                    </div>
                  )}
                  <div className="text-center font-mono text-[8px] text-slate-700 mt-1 uppercase tracking-wider">
                    App pairing QR
                  </div>
                </div>
                <div className="space-y-2 text-xs min-w-0 flex-1">
                  <div className="flex flex-wrap gap-1.5 font-mono text-[9px] font-bold tracking-wider">
                    <span
                      className="px-1.5 py-0.5 rounded border border-emerald-500/35 bg-emerald-950/30 text-emerald-300"
                      title="Install the companion APK on an Android phone, then scan this QR with the phone camera — the app opens already paired to this console."
                    >
                      APK PAIR · CAMERA SCAN
                    </span>
                    <span
                      className="px-1.5 py-0.5 rounded border border-emerald-500/35 bg-emerald-950/30 text-emerald-300"
                      title="Works fully offline on the sanctuary Wi-Fi; the same live fader, mute, zone and master-trim sync as the browser companion."
                    >
                      OFFLINE · FULL SYNC
                    </span>
                  </div>
                  <a
                    href="/downloads/HKM-FOH-Companion.apk"
                    download="HKM-FOH-Companion.apk"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded font-mono font-semibold no-underline cursor-pointer hw-key !bg-none !border-emerald-400 !bg-emerald-600 !text-white"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>DOWNLOAD APK · 4 MB</span>
                  </a>
                  <div
                    className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-slate-800 bg-[#070A10] font-mono text-[9px] font-bold tracking-wider text-slate-500"
                    title="Android 7.0+ · debug-signed build · enable Install unknown apps when prompted. The QR above also works without the app: the standard pairing QR (left) opens the browser companion instead."
                  >
                    ANDROID 7.0+ · DEBUG SIGNED · BROWSER QR FALLBACK
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Security Permissions + Connected Mobile Clients */}
          <div className="lg:col-span-7 space-y-4">
            <div className="rounded-lg border border-slate-800 bg-[#0D1119] p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span
                  className="font-mono text-xs font-semibold text-white uppercase flex items-center gap-2 hw-engraved"
                  title="FOH Companion Permissions & PIN Guard"
                >
                  <Lock className="w-3.5 h-3.5 text-sky-400" />
                  <span>PERMISSIONS · PIN GUARD</span>
                </span>
                <span
                  className="font-mono text-[10px] text-slate-400"
                  title={
                    activeDevice.capabilities.perChannelFaderControl
                      ? 'Hardware Link — the console drives physical faders on this device'
                      : 'Software DSP Return — control is applied inside the software DSP chain'
                  }
                >
                  {activeDevice.capabilities.perChannelFaderControl
                    ? `HW LINK · ${activeDevice.model}`
                    : `SW DSP · ${activeDevice.model}`}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded border border-slate-800 bg-[#070A10] flex items-center justify-between gap-3">
                  <div title="Require 4-digit PIN — prompts mobile devices before unlocking faders">
                    <div className="font-semibold text-slate-100">PIN GATE</div>
                    <div className="text-[9px] font-mono font-bold tracking-wider text-slate-500 uppercase">
                      MOBILE LOCK
                    </div>
                  </div>
                  <ConsolePushButton
                    label={remoteAccess.pinEnabled ? 'PIN ON' : 'PIN OFF'}
                    active={remoteAccess.pinEnabled}
                    tone="amber"
                    onClick={() => onUpdateRemoteAccess({ pinEnabled: !remoteAccess.pinEnabled })}
                  />
                </div>

                <div className="p-3 rounded border border-slate-800 bg-[#070A10] flex items-center justify-between gap-3">
                  <div title="Session Security PIN — 4–8 digit FOH passcode">
                    <div className="font-semibold text-slate-100">PIN CODE</div>
                    <div className="text-[9px] font-mono font-bold tracking-wider text-slate-500 uppercase">
                      4–8 DIGIT
                    </div>
                  </div>
                  <input
                    type="text"
                    maxLength={8}
                    value={remoteAccess.pinCode}
                    onChange={(e) => onUpdateRemoteAccess({ pinCode: e.target.value })}
                    className="w-24 h-8 px-2 rounded border border-slate-700 bg-[#0E1524] font-mono text-center text-xs text-white"
                  />
                </div>

                <div className="p-3 rounded border border-slate-800 bg-[#070A10] flex items-center justify-between gap-3">
                  <div title="Preamp Gain Adjustment — allow mobile gain & +48V trim control">
                    <div className="font-semibold text-slate-100">GAIN / +48V</div>
                    <div className="text-[9px] font-mono font-bold tracking-wider text-slate-500 uppercase">
                      MOBILE GAIN
                    </div>
                  </div>
                  <ConsolePushButton
                    label={remoteAccess.allowGainAdjustment ? 'ALLOWED' : 'LOCKED'}
                    active={remoteAccess.allowGainAdjustment}
                    tone="emerald"
                    onClick={() =>
                      onUpdateRemoteAccess({
                        allowGainAdjustment: !remoteAccess.allowGainAdjustment,
                      })
                    }
                  />
                </div>

                <div className="p-3 rounded border border-slate-800 bg-[#070A10] flex items-center justify-between gap-3">
                  <div title="Mute / Solo & Master — allow channel mutes & master trim">
                    <div className="font-semibold text-slate-100">MUTE / MASTER</div>
                    <div className="text-[9px] font-mono font-bold tracking-wider text-slate-500 uppercase">
                      MOBILE MUTE
                    </div>
                  </div>
                  <ConsolePushButton
                    label={remoteAccess.allowMuteControl ? 'ALLOWED' : 'LOCKED'}
                    active={remoteAccess.allowMuteControl}
                    tone="emerald"
                    onClick={() =>
                      onUpdateRemoteAccess({
                        allowMuteControl: !remoteAccess.allowMuteControl,
                        allowMasterTrim: !remoteAccess.allowMuteControl,
                      })
                    }
                  />
                </div>
              </div>
            </div>

            {/* Active Connected Mobile Companions */}
            <div className="rounded-lg border border-slate-800 bg-[#0D1119] p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="font-mono text-xs font-semibold text-white uppercase flex items-center gap-2 hw-engraved">
                  <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  <span>LINKED DEVICES ({remoteClients.length})</span>
                </span>
                <span
                  className="font-mono text-[10px] text-slate-400"
                  title="Real-Time WebSocket Sync (/ws)"
                >
                  WS SYNC · /WS
                </span>
              </div>

              {remoteClients.length === 0 ? (
                <div
                  className="p-4 rounded border border-slate-800 bg-[#070A10] flex items-center justify-center gap-2"
                  title="No companion devices currently linked. Scan the QR code on a phone/tablet or click Open Mobile View to verify live fader and gain synchronization."
                >
                  <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
                  <span className="font-mono text-[10px] font-bold tracking-wider text-slate-400">
                    NO DEVICES · SCAN QR
                  </span>
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {remoteClients.map((cli) => (
                    <div
                      key={cli.clientId}
                      className="py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-white flex items-center gap-2">
                          <span>{cli.deviceName}</span>
                          <span className="font-mono text-[10px] text-emerald-400">LIVE</span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                          IP: {cli.ip} · CONN {new Date(cli.connectedAt).toLocaleTimeString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onDisconnectRemoteClient(cli.clientId)}
                        title="Revoke this companion device and close its WebSocket sync"
                        className="px-2.5 py-1 rounded font-mono text-[11px] flex items-center gap-1 shrink-0 cursor-pointer hw-key !border-red-500/40 !text-red-300"
                      >
                        <UserX className="w-3.5 h-3.5" />
                        <span>REVOKE</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'hardware' && (
        <div className="space-y-4">
          {/* System Audio Input Bridge & Self-Loopback Firewall Card */}
          <div className="rounded-lg border border-cyan-500/45 bg-gradient-to-b from-[#091821] to-[#070E14] text-slate-100 p-4 space-y-3.5 shadow-lg shadow-cyan-950/30">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-cyan-500/20 pb-3">
              <div className="space-y-1">
                <div className="font-mono text-xs font-bold text-cyan-300 uppercase tracking-wide flex flex-wrap items-center gap-2">
                  <span
                    className="hw-lamp shrink-0"
                    style={{ width: 8, height: 8 }}
                    data-on={
                      audioSource === 'desktop-audio' && engineRunning
                        ? desktopBridgeState?.selfLoopbackBlocked
                          ? 'amber'
                          : 'green'
                        : desktopBuild && desktopAudioStatus?.supported
                          ? 'green'
                          : 'cyan'
                    }
                    aria-hidden="true"
                  />
                  <span
                    className="font-mono text-xs font-bold text-cyan-300 uppercase tracking-wide"
                    title="System Audio Input Bridge (Desktop / Media / Browser Audio · Loopback Guarded)"
                  >
                    SYSTEM AUDIO INPUT BRIDGE
                  </span>
                  {desktopBridgeState && (
                    <span
                      className={`px-2 py-0.5 rounded text-[9.5px] font-mono border ${
                        desktopBridgeState.selfLoopbackBlocked
                          ? 'border-amber-400/60 bg-amber-500/15 text-amber-300'
                          : desktopBridgeState.active
                            ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-300'
                            : 'border-slate-700 bg-slate-900 text-slate-400'
                      }`}
                    >
                      {desktopBridgeState.loopbackRisk === 'unsafe-shared-bus'
                        ? 'FIREWALL · MON MUTED'
                        : desktopBridgeState.loopbackRisk === 'safe-tab-isolated'
                          ? 'SAFE · TAB ISOLATED'
                          : desktopBridgeState.loopbackRisk === 'safe-separate-output'
                            ? 'SAFE · SEPARATE OUTPUT'
                            : desktopBridgeState.loopbackRisk === 'safe-process-excluded'
                              ? 'SAFE · PROCESS EXCLUDED'
                              : 'BRIDGE STANDBY'}
                    </span>
                  )}
                </div>
                {/* Safety status line — engraved status chip; the full safety
                    reason + method walkthrough lives in Help Desk → System & Hardware */}
                <div className="flex items-center gap-2 max-w-4xl">
                  <span
                    className="hw-lamp shrink-0"
                    style={{ width: 6, height: 6 }}
                    data-on={
                      desktopBridgeState?.selfLoopbackBlocked
                        ? 'amber'
                        : desktopBridgeState?.active
                          ? 'green'
                          : undefined
                    }
                    aria-hidden="true"
                  />
                  <span className="font-mono text-[10px] text-slate-300 truncate" title={desktopBridgeState?.safetyReason ?? undefined}>
                    {desktopBridgeState?.safetyReason
                      ? 'SAFETY: ' + desktopBridgeState.safetyReason
                      : desktopBuild
                        ? 'WASAPI PROCESS-EXCLUSION LOOPBACK — ZERO-FEEDBACK ENGINE 1'
                        : 'GETDISPLAYMEDIA / VIRTUAL CABLE BRIDGE — SELF-LOOPBACK FIREWALL ON'}
                  </span>
                  <button
                    type="button"
                    onClick={() => openHelpTopic('hardware-bridge')}
                    title="Open the System Audio Bridge methods walkthrough in the Help Desk"
                    className="px-2 py-0.5 rounded border border-[#2A3646] bg-[#0A0F16] text-slate-300 hover:text-white hover:border-teal-400/50 font-mono text-[9px] font-bold tracking-wider cursor-pointer shrink-0"
                  >
                    GUIDE
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {desktopBuild && onRefreshDesktopAudio && (
                  <button
                    type="button"
                    onClick={onRefreshDesktopAudio}
                    title="Refresh detected desktop audio apps & APO status"
                    className="px-2.5 py-1.5 rounded font-mono text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer hw-key !border-cyan-500/40 !text-cyan-200"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>REFRESH APPS &amp; APO</span>
                  </button>
                )}
                {!desktopBuild && onSelectAudioSource && (
                  <button
                    type="button"
                    onClick={() => {
                      if (onSelectDesktopCaptureMethod) {
                        void onSelectDesktopCaptureMethod('display-media', true);
                      } else {
                        onSelectAudioSource('desktop-audio');
                        if (!engineRunning && onToggleEngine) {
                          onToggleEngine();
                        }
                      }
                    }}
                    className={`px-3 py-1.5 rounded font-mono text-[11px] font-semibold cursor-pointer hw-key ${
                      audioSource === 'desktop-audio' && engineRunning
                        ? '!bg-none !border-emerald-400 !bg-emerald-600 !text-white'
                        : '!border-emerald-500/50 !text-emerald-300'
                    }`}
                  >
                    {audioSource === 'desktop-audio' && engineRunning
                      ? 'RE-PICK TAB'
                      : 'SHARE SYSTEM AUDIO'}
                  </button>
                )}
              </div>
            </div>

            {!desktopBuild && desktopBridgeState && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
                <div className="lg:col-span-6 rounded-md border border-slate-800 bg-[#070B11] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span
                      className="font-mono text-[11px] font-bold text-cyan-300 uppercase"
                      title="Method 1 · Web Audio getDisplayMedia (Zero Driver)"
                    >
                      METHOD 1 · GETDISPLAYMEDIA
                    </span>
                    <button
                      type="button"
                      onClick={() => onSelectDesktopCaptureMethod?.('display-media', true)}
                      className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold cursor-pointer ${
                        desktopBridgeState.method === 'display-media' && desktopBridgeState.active
                          ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
                          : 'border-cyan-500/45 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                      }`}
                    >
                      {desktopBridgeState.method === 'display-media' && desktopBridgeState.active
                        ? 'ACTIVE (RE-PICK)'
                        : 'USE PICKER'}
                    </button>
                  </div>
                  {/* Method facts as engraved LED chips — details in tooltips */}
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px] font-bold tracking-wider">
                    <span className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-cyan-500/35 bg-cyan-950/30 text-cyan-300"
                      title="Enforces selfBrowserSurface: 'exclude' so this console cannot capture itself">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> SELF-EXCLUDE
                    </span>
                    <span className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-cyan-500/35 bg-cyan-950/30 text-cyan-300"
                      title="Requests suppressLocalAudioPlayback: true on browser tabs to prevent echo">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> NO ECHO
                    </span>
                    <span className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-cyan-500/35 bg-cyan-950/30 text-cyan-300"
                      title="Automatically mutes monitor output if capturing Whole Screen on shared default speakers">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> AUTO-MUTE MON
                    </span>
                  </div>
                </div>

                <div className="lg:col-span-6 rounded-md border border-slate-800 bg-[#070B11] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span
                      className="font-mono text-[11px] font-bold text-emerald-300 uppercase"
                      title="Method 2 · Specialized Virtual Interface"
                    >
                      METHOD 2 · VIRTUAL CABLE ({specializedDesktopInputs.length})
                    </span>
                  </div>
                  {specializedDesktopInputs.length === 0 ? (
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="hw-lamp shrink-0"
                          style={{ width: 5, height: 5 }}
                          aria-hidden="true"
                        />
                        <span
                          className="font-mono text-[10px] text-slate-400 truncate"
                          title="No virtual audio bridge detected yet (VB-Audio Cable, BlackHole, Stereo Mix, or VoiceMeeter). Click Refresh Hardware after installing or enabling Stereo Mix in Windows Sound settings."
                        >
                          NO VIRTUAL BRIDGE DETECTED
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => openHelpTopic('hardware-bridge')}
                        title="How to install / enable a virtual audio bridge — Help Desk"
                        className="px-2 py-0.5 rounded border border-[#2A3646] bg-[#0A0F16] text-slate-400 hover:text-white hover:border-teal-400/50 font-mono text-[9px] font-bold tracking-wider cursor-pointer shrink-0"
                      >
                        HOW-TO
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                      {specializedDesktopInputs.map((iface) => {
                        const isSelected =
                          desktopBridgeState.specializedDeviceId === iface.deviceId &&
                          desktopBridgeState.method !== 'display-media';
                        return (
                          <div
                            key={iface.deviceId}
                            className={`px-2.5 py-1.5 rounded border flex items-center justify-between gap-2 font-mono text-[10px] ${
                              isSelected
                                ? 'border-emerald-400/70 bg-emerald-950/30 text-emerald-100'
                                : 'border-slate-800 bg-[#0B1018] text-slate-300'
                            }`}
                          >
                            <span className="truncate" title={iface.label}>
                              {iface.label}
                            </span>
                            <button
                              type="button"
                              onClick={() => void onSelectSpecializedDesktopDevice?.(iface, true)}
                              className={`px-2 py-0.5 rounded border text-[9.5px] font-bold shrink-0 cursor-pointer ${
                                isSelected
                                  ? 'border-emerald-300 bg-emerald-500 text-slate-950'
                                  : 'border-cyan-500/45 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                              }`}
                            >
                              {isSelected ? 'ACTIVE' : 'ROUTE BRIDGE'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {desktopBuild && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
                {/* Engine 1 Panel */}
                <div className="lg:col-span-5 rounded-md border border-slate-800 bg-[#070B11] p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span
                      className="font-mono text-[11px] font-bold text-cyan-300 uppercase"
                      title="Engine 1 · Driverless Process Loopback"
                    >
                      ENGINE 1 · PROCESS LOOPBACK
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                        desktopAudioStatus?.supported
                          ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                          : 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                      }`}
                    >
                      {desktopAudioStatus?.supported
                        ? `READY (BUILD ${desktopAudioStatus.osBuild || 'WIN11'})`
                        : 'UNAVAILABLE'}
                    </span>
                  </div>

                  {/* Engine 1 facts as engraved LED chips */}
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px] font-bold tracking-wider">
                    <span className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-cyan-500/35 bg-cyan-950/30 text-cyan-300"
                      title="No VB-Audio Virtual Cable required, zero picker dialogs, zero Admin needed">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> NO CABLE REQ
                    </span>
                    <span className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-cyan-500/35 bg-cyan-950/30 text-cyan-300"
                      title="Auto-slotted to CH N+1 after connected hardware microphones">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> AUTO-SLOT CH N+1
                    </span>
                    <span className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-cyan-500/35 bg-cyan-950/30 text-cyan-300"
                      title="Speaker routing temporarily mutes Windows source-app sessions and restores their prior mute states when monitoring stops">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> MUTE-RESTORE
                    </span>
                  </div>

                  {/* Quick Browser -> DSP -> Built-In Speakers Strip */}
                  <div className="rounded border border-cyan-500/35 bg-[#0A131C] p-2.5 space-y-2">
                    <div
                      className="font-mono text-[10px] font-bold text-cyan-200 uppercase hw-engraved"
                      title="Browser → DSP → Built-In Speakers (Source Isolation)"
                    >
                      BROWSER → DSP → SPEAKERS
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {onEnableBrowserDspSpeakers && (
                        <button
                          type="button"
                          onClick={onEnableBrowserDspSpeakers}
                          title="One click: route browser audio through DSP to the built-in speakers"
                          className="px-2.5 py-1 rounded font-mono text-[10px] font-bold cursor-pointer hw-key !border-cyan-400/60 !text-cyan-100"
                        >
                          1-CLICK BROWSER → DSP → SPEAKERS
                        </button>
                      )}
                      {onOpenWindowsSoundMixer && (
                        <button
                          type="button"
                          onClick={onOpenWindowsSoundMixer}
                          className="px-2.5 py-1 rounded font-mono text-[10px] font-semibold cursor-pointer hw-key"
                        >
                          OPEN WINDOWS VOLUME MIXER
                        </button>
                      )}
                    </div>
                    <div
                      className={`flex flex-wrap items-center gap-1.5 font-mono text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border w-fit ${
                        desktopSourceIsolationStatus?.enabled
                          ? 'border-emerald-500/35 bg-emerald-950/30 text-emerald-300'
                          : desktopSourceIsolationStatus?.skippedSessions
                            ? 'border-amber-500/35 bg-amber-950/30 text-amber-300'
                            : 'border-slate-700 bg-[#0A0F16] text-slate-400'
                      }`}
                      title={
                        desktopSourceIsolationStatus?.enabled
                          ? `Source isolation is active; HKM is managing mute states for ${desktopSourceIsolationStatus.mutedSessions} Windows app session(s). New sessions are checked about once per second.`
                          : desktopSourceIsolationStatus?.skippedSessions
                            ? `Speaker monitoring is held off because ${desktopSourceIsolationStatus.skippedSessions} Windows audio session(s) could not be safely isolated. ${desktopSourceIsolationStatus.message || ''}`
                            : 'No virtual cable is needed. Windows process loopback captures app audio before session mute; HKM temporarily mutes source-app sessions while its processed output is sent to the speakers.'
                      }
                    >
                      <span
                        className="hw-lamp shrink-0"
                        style={{ width: 5, height: 5 }}
                        data-on={
                          desktopSourceIsolationStatus?.enabled
                            ? 'green'
                            : desktopSourceIsolationStatus?.skippedSessions
                              ? 'amber'
                              : undefined
                        }
                        aria-hidden="true"
                      />
                      {desktopSourceIsolationStatus?.enabled
                        ? `ISOLATION ON · ${desktopSourceIsolationStatus.mutedSessions} APPS MUTED`
                        : desktopSourceIsolationStatus?.skippedSessions
                          ? `ISOLATION HOLD · ${desktopSourceIsolationStatus.skippedSessions} SKIPPED`
                          : 'LOOPBACK PRE-MUTE · NO CABLE REQ'}
                    </div>
                  </div>

                  <div className="pt-1 border-t border-slate-800/90 space-y-1">
                    <div className="font-mono text-[9.5px] text-slate-400 uppercase font-semibold hw-engraved">
                      ACTIVE AUDIO APPS ({desktopAudioSessions.length})
                    </div>
                    {desktopAudioSessions.length === 0 ? (
                      <div
                        className="flex items-center gap-2 font-mono text-[9px] font-bold tracking-wider text-slate-500"
                        title="Start playing audio in Chrome, Edge, Spotify, or VLC to see individual app sessions here or in the left patch tray."
                      >
                        <span className="hw-lamp" style={{ width: 5, height: 5 }} aria-hidden="true" />
                        NO APP SESSIONS
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {desktopAudioSessions.map((s) => (
                          <span
                            key={`diag-sess-${s.pid}`}
                            className="px-2 py-0.5 rounded border border-cyan-500/35 bg-cyan-950/30 font-mono text-[10px] text-cyan-200 flex items-center gap-1"
                          >
                            <span
                              className="hw-lamp shrink-0"
                              style={{ width: 5, height: 5 }}
                              data-on={s.state === 'active' ? 'green' : undefined}
                              aria-hidden="true"
                            />
                            {s.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Engine 2 Panel */}
                <div className="lg:col-span-7 rounded-md border border-slate-800 bg-[#070B11] p-3 space-y-2.5">
                  {(() => {
                    const endpoints = apoStatus?.endpoints ?? [];
                    const effectiveEpId =
                      selectedApoEndpointId ||
                      apoStatus?.selectedEndpointId ||
                      endpoints.find((e) => e.isDefault)?.id ||
                      endpoints[0]?.id ||
                      '';
                    const activeEp = endpoints.find((e) => e.id === effectiveEpId);

                    return (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span
                            className="font-mono text-[11px] font-bold text-amber-300 uppercase"
                            title="Engine 2 · Opt-In System APO (Single-Speaker Zero-Doubling)"
                          >
                            ENGINE 2 · SYSTEM APO
                          </span>
                          <div className="flex flex-wrap items-center gap-1 font-mono text-[9px]">
                            <span
                              className={`px-1.5 py-0.5 rounded border ${
                                apoStatus?.dllBundled
                                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                  : 'border-slate-700 bg-slate-900 text-slate-400'
                              }`}
                            >
                              {apoStatus?.dllBundled ? 'DLL BUNDLED' : 'DLL MISSING'}
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded border ${
                                apoStatus?.apoLoadedInAudiodg
                                  ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
                                  : apoStatus?.apoRegisteredAny
                                    ? 'border-amber-500/45 bg-amber-500/15 text-amber-300'
                                    : 'border-slate-700 bg-slate-900 text-slate-400'
                              }`}
                            >
                              {apoStatus?.apoLoadedInAudiodg
                                ? 'LIVE IN AUDIODG'
                                : apoStatus?.apoRegisteredAny
                                  ? 'REGISTERED (PPL PENDING)'
                                  : 'NOT INSTALLED'}
                            </span>
                            <span className="px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-950/30 text-sky-300">
                              500MS FAIL-SAFE
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                          <div className="sm:col-span-7">
                            <label className="block font-mono text-[9.5px] text-slate-400 uppercase mb-1 hw-engraved">
                              TARGET SPEAKER · {activeEp?.rawSupported ? 'RAW OK' : 'CHECK RAW'}
                            </label>
                            <select
                              value={effectiveEpId}
                              onChange={(e) => setSelectedApoEndpointId(e.target.value)}
                              className="w-full h-8 px-2 rounded border border-slate-700 bg-[#0B1018] text-slate-100 text-[11px] font-mono"
                            >
                              {endpoints.length === 0 ? (
                                <option value="">System Default Endpoint</option>
                              ) : (
                                endpoints.map((ep) => (
                                  <option key={ep.id} value={ep.id}>
                                    {ep.name} {ep.isDefault ? '(Default)' : ''} ·{' '}
                                    {ep.rawSupported ? 'RAW OK' : 'No RAW'}
                                    {ep.apoRegistered ? ' · APO Installed' : ''}
                                  </option>
                                ))
                              )}
                            </select>
                          </div>

                          <div className="sm:col-span-5 flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={!effectiveEpId || apoBusy || !onInstallApo}
                              onClick={() => effectiveEpId && onInstallApo?.(effectiveEpId)}
                              title="Install the APO on the selected speaker (requires Admin elevation)"
                              className="flex-1 h-8 px-2 rounded font-mono text-[10px] font-bold disabled:opacity-40 cursor-pointer hw-key !border-amber-500/50 !text-amber-200"
                            >
                              {apoBusy ? 'WORKING…' : 'INSTALL APO · ADMIN'}
                            </button>
                            <button
                              type="button"
                              disabled={!effectiveEpId || apoBusy || !onUninstallApo}
                              onClick={() => effectiveEpId && onUninstallApo?.(effectiveEpId)}
                              className="h-8 px-2 rounded font-mono text-[10px] font-bold disabled:opacity-40 cursor-pointer hw-key"
                            >
                              UNINSTALL
                            </button>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/80">
                          <span className="font-mono text-[10px] text-slate-400">
                            {apoStatus?.note}
                          </span>
                          {onToggleSingleSpeakerMode && (
                            <button
                              type="button"
                              onClick={() =>
                                onToggleSingleSpeakerMode(!singleSpeakerMode, effectiveEpId || undefined)
                              }
                              className={`px-3 py-1 rounded font-mono text-[10px] font-bold shrink-0 cursor-pointer hw-key ${
                                singleSpeakerMode
                                  ? '!bg-none !border-emerald-400 !bg-emerald-600 !text-white'
                                  : '!border-cyan-500/50 !text-cyan-200'
                              }`}
                            >
                              {singleSpeakerMode
                                ? 'ZERO-DOUBLING ON · RAW OUT'
                                : 'ENGAGE ZERO-DOUBLING'}
                            </button>
                          )}
                        </div>

                        {apoMessage && (
                          <div
                            className={`p-2 rounded border font-mono text-[10px] ${
                              apoMessage.tone === 'success'
                                ? 'border-emerald-500/45 bg-emerald-950/35 text-emerald-200'
                                : apoMessage.tone === 'error'
                                  ? 'border-red-500/45 bg-red-950/35 text-red-200'
                                  : 'border-sky-500/45 bg-sky-950/35 text-sky-200'
                            }`}
                          >
                            {apoMessage.text}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>

          {/* Auto-Recognized Connected Hardware Panel */}
          <div className="rounded-lg border border-sky-500/35 bg-[#0D131F] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                <Radar className="w-4 h-4 text-sky-400" />
                <div className="min-w-0">
                  <div
                    className="font-mono text-xs font-semibold text-white uppercase hw-engraved"
                    title="Auto-Recognized Connected Hardware (Internal & External)"
                  >
                    AUTO-RECOGNIZED HARDWARE · INT + EXT
                  </div>
                  {/* Recognition capabilities as engraved chips — details in
                      Help Desk → System & Hardware */}
                  <div className="flex flex-wrap items-center gap-1.5 mt-1 font-mono text-[8.5px] font-bold tracking-wider">
                    <span className="px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-950/30 text-sky-300"
                      title="Automatic USB VID:PID fingerprinting profiles every connected interface">USB VID:PID</span>
                    <span className="px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-950/30 text-sky-300"
                      title="Internal sound card profiling">CARD PROFILING</span>
                    <span className="px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-950/30 text-sky-300"
                      title="LAN OSC console discovery">LAN OSC</span>
                    <span className="px-1.5 py-0.5 rounded border border-sky-500/35 bg-sky-950/30 text-sky-300"
                      title="Hot-plug listener detects devices the moment they connect">HOT-PLUG</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {detectedEndpoints.length > 0 && onClearHardwareCache && (
                  <button
                    type="button"
                    onClick={onClearHardwareCache}
                    title="Clear the remembered-device cache (IndexedDB)"
                    className="px-2.5 py-1.5 rounded font-mono text-[11px] cursor-pointer hw-key"
                  >
                    CLEAR CACHE
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onScanHardware(true)}
                  disabled={scanningHardware}
                  title="Re-scan USB / internal / LAN hardware endpoints"
                  className="px-3 py-1.5 rounded font-mono text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer hw-key !border-sky-400/50 !text-sky-200"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${scanningHardware ? 'animate-spin' : ''}`} />
                  <span>{scanningHardware ? 'SCANNING BUS…' : 'RE-SCAN HARDWARE'}</span>
                </button>
              </div>
            </div>

            {detectedEndpoints.length === 0 ? (
              <div className="p-3 rounded border border-slate-800 bg-[#070A10] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="hw-lamp shrink-0" style={{ width: 6, height: 6 }} aria-hidden="true" />
                  <span
                    className="font-mono text-[11px] text-slate-300"
                    title="Plug in any USB mixer or audio interface on Windows/macOS/Linux, or click Re-Scan Hardware to unlock browser MediaDevices labels and probe local cards. Remembered devices persist in IndexedDB for instant offline recall."
                  >
                    NO OS ENDPOINTS ENUMERATED
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onScanHardware(true)}
                  className="px-3 py-1.5 rounded font-mono text-[11px] font-semibold shrink-0 cursor-pointer hw-key !bg-none !border-sky-400 !bg-sky-600 !text-white"
                >
                  GRANT &amp; SCAN INTERFACES
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {detectedEndpoints.map((ep) => {
                  const isBound = activeDevice.id === ep.matchedDeviceId;
                  const kindLabel =
                    ep.kind === 'internal'
                      ? 'INTERNAL CARD'
                      : ep.kind === 'usb-audio'
                        ? 'USB INTERFACE'
                        : ep.kind === 'network-console'
                          ? 'LAN CONSOLE'
                          : ep.kind === 'virtual'
                            ? 'VIRTUAL BUS'
                            : ep.kind.toUpperCase();

                  return (
                    <div
                      key={ep.id}
                      className={`p-3 rounded border flex flex-col justify-between gap-2.5 ${
                        isBound
                          ? 'border-emerald-400/70 bg-emerald-950/20'
                          : 'border-slate-800 bg-[#070A10]'
                      }`}
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] font-bold text-sky-300 uppercase flex items-center gap-1">
                            <Usb className="w-3 h-3" />
                            {kindLabel}
                            {ep.isDefault ? ' · DEFAULT' : ''}
                          </span>
                          <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                            {ep.cachedFromIndexedDb ? 'IDB CACHED' : 'LIVE ON BUS'}
                          </span>
                        </div>

                        <div className="text-xs font-semibold text-white truncate" title={ep.name}>
                          {ep.name}
                        </div>

                        <div className="font-mono text-[11px] text-slate-400 space-y-0.5 tabular-nums">
                          <div>
                            PROFILE: {ep.matchedLabel} ·{' '}
                            {ep.confidence === 'auto-synthesized'
                              ? 'AUTO-PROFILE'
                              : ep.confidence}
                          </div>
                          <div>
                            {ep.estimatedInputChannels}×{ep.estimatedOutputChannels} ch · {ep.recommendedDriver} · {(ep.recommendedSampleRate / 1000).toFixed(1)} kHz
                          </div>
                          {(ep.vendorId || ep.hostAddress || ep.lastSeenAt) && (
                            <div className="text-slate-500">
                              {ep.vendorId
                                ? `USB VID:${ep.vendorId.toUpperCase()} PID:${(ep.productId || '----').toUpperCase()}`
                                : ep.hostAddress
                                  ? `Host IP: ${ep.hostAddress}`
                                  : 'System Audio'}
                              {ep.seenCount ? ` · SEEN ${ep.seenCount}×` : ''}
                            </div>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => onBindDetectedEndpoint(ep)}
                        title={
                          isBound
                            ? 'Bound — profile recalled'
                            : 'Auto-bind this endpoint and recall its mix profile'
                        }
                        className={`w-full py-1.5 px-2.5 rounded font-mono text-[11px] font-semibold transition-colors cursor-pointer hw-key ${
                          isBound
                            ? '!bg-none !border-emerald-400 !bg-emerald-600 !text-white'
                            : '!bg-none !border-sky-400 !bg-sky-600 !text-white'
                        }`}
                      >
                        {isBound ? 'BOUND · RECALLED' : 'AUTO-BIND'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'plugins' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-6 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-3">
            <div
              className="font-mono text-xs font-semibold text-white uppercase border-b border-slate-800 pb-2 hw-engraved"
              title="Registered Hardware Driver & DSP Modules"
            >
              REGISTERED MODULES
            </div>
            <div className="divide-y divide-slate-800/80">
              {plugins.map((pl) => (
                <div key={pl.id} className="py-3 first:pt-0 last:pb-0 flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-white">{pl.name}</span>
                      <span className="font-mono text-[10px] text-slate-500">v{pl.version}</span>
                    </div>
                    <div className="font-mono text-[11px] text-sky-400">
                      {pl.kind} · {pl.supportedPlatforms.join(' / ')} · {pl.entryPoint}
                    </div>
                    <p className="text-xs text-slate-400">{pl.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <ConsolePushButton
                      label={pl.status === 'active' ? 'ENABLED' : 'DISABLED'}
                      active={pl.status === 'active'}
                      tone="emerald"
                      onClick={() => onTogglePlugin(pl.id)}
                    />
                    {!pl.builtin && (
                      <button
                        type="button"
                        onClick={() => onUnloadPlugin(pl.id)}
                        aria-label={`Unload ${pl.name}`}
                        className="p-1 text-slate-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-6 space-y-4">
            <div className="rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className="font-mono text-xs font-semibold text-white uppercase hw-engraved"
                  title="Hot-Load Plugin Manifest (JSON)"
                >
                  HOT-LOAD MANIFEST · JSON
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPluginDraft(SAMPLE_CUSTOM_HARDWARE_PLUGIN)}
                    title="Load the Midas M32R sample manifest"
                    className="text-[11px] font-mono px-2 py-1 rounded cursor-pointer hw-key"
                  >
                    M32R SAMPLE
                  </button>
                  <button
                    type="button"
                    onClick={() => setPluginDraft(SAMPLE_CUSTOM_DSP_PLUGIN)}
                    title="Load the Choir Air sample manifest"
                    className="text-[11px] font-mono px-2 py-1 rounded cursor-pointer hw-key"
                  >
                    CHOIR AIR SAMPLE
                  </button>
                </div>
              </div>

              <textarea
                value={pluginDraft}
                onChange={(e) => setPluginDraft(e.target.value)}
                rows={9}
                className="w-full p-2.5 rounded bg-[#070A10] border border-slate-800 font-mono text-[11px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />

              {pluginError && <div className="text-xs text-red-400">{pluginError}</div>}
              {pluginSuccess && <div className="text-xs text-emerald-400">{pluginSuccess}</div>}

              <button
                type="button"
                onClick={handleInstallPlugin}
                title="Register & hot-load the plugin manifest into the runtime"
                className="w-full py-2 px-3 rounded font-mono text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer hw-key !bg-none !border-sky-400 !bg-sky-600 !text-white"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>HOT-LOAD PLUGIN</span>
              </button>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-2">
              <div
                className="font-mono text-xs font-semibold text-white uppercase hw-engraved"
                title="Plugin Authoring SDK Contract"
              >
                PLUGIN SDK CONTRACT
              </div>
              <pre className="p-3 rounded bg-[#070A10] border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto leading-relaxed">
                {PLUGIN_SDK_CONTRACT_SNIPPET}
              </pre>
            </div>
          </div>
        </div>
      )}

      {tab === 'crossplatform' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {(['windows', 'macos', 'linux'] as PlatformTarget[]).map((osKey) => {
            const spec = PLATFORM_SPECS[osKey];
            const active = platform === osKey;
            return (
              <div
                key={osKey}
                className={`p-4 rounded-lg border space-y-3 ${
                  active ? 'border-sky-400 bg-[#121B2B]' : 'border-slate-800 bg-[#0D1119]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-white">{spec.title}</div>
                    <div className="font-mono text-[10px] text-sky-400 uppercase">{spec.role}</div>
                  </div>
                  <ConsolePushButton
                    label={active ? 'ACTIVE' : 'SELECT'}
                    active={active}
                    tone="sky"
                    onClick={() => {
                      onSelectPlatform(osKey);
                      onSelectDriver(spec.backends[0]);
                    }}
                  />
                </div>

                <div className="space-y-1 text-xs">
                  <div className="font-mono text-[10px] text-slate-500 uppercase">Audio Backends</div>
                  <div className="font-mono text-emerald-400">{spec.backends.join(' · ')}</div>
                </div>

                <div className="space-y-1 text-xs">
                  <div className="font-mono text-[10px] text-slate-500 uppercase">Sidecar Binary</div>
                  <div className="font-mono text-[11px] text-slate-300 break-all">
                    {spec.binaryResolution}
                  </div>
                </div>

                <div className="space-y-1 text-xs">
                  <div className="font-mono text-[10px] text-slate-500 uppercase">Tauri 2 Build</div>
                  <pre className="p-2 rounded bg-[#070A10] border border-slate-800 font-mono text-[10px] text-sky-300 overflow-x-auto">
                    {spec.buildTarget}
                  </pre>
                </div>

                <div
                  className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-slate-700 bg-[#070A10] font-mono text-[9px] font-bold tracking-wider text-slate-400"
                  title={spec.notes}
                >
                  DRIVER NOTES · {osKey.toUpperCase()}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'watchdog' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5">
            <ArcGauge
              label="System CPU"
              value={systemCpuPercent ?? 0}
              max={100}
              displayValue={systemCpuPercent === null ? '—' : `${systemCpuPercent}%`}
              sublabel={systemCpuPercent === null ? 'N/A · PLATFORM' : 'SYSTEM-WIDE'}
              tone={
                systemCpuPercent === null
                  ? 'sky'
                  : systemCpuPercent >= 80
                    ? 'red'
                    : systemCpuPercent >= 60
                      ? 'amber'
                      : 'sky'
              }
            />
            <ArcGauge
              label="Sample Clock State"
              value={telemetry.isRunning ? 100 : 0}
              max={100}
              displayValue={telemetry.isRunning ? 'LOCKED' : 'IDLE'}
              sublabel={
                telemetry.isRunning
                  ? `${(telemetry.sampleRate / 1000).toFixed(1)} kHz Active`
                  : `${(sampleRate / 1000).toFixed(1)} kHz Configured`
              }
              tone={telemetry.isRunning ? 'emerald' : 'sky'}
            />
            <ArcGauge
              label="CLIP GUARD"
              value={Math.max(10, 100 - telemetry.clippingEvents * 10)}
              max={100}
              displayValue={`${telemetry.clippingEvents} Clips`}
              sublabel={`${bufferSize} smp · ${driver}`}
              tone={telemetry.clippingEvents > 0 ? 'amber' : 'emerald'}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-5 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-3">
              <div
                className="font-mono text-xs font-semibold text-white uppercase border-b border-slate-800 pb-2 hw-engraved"
                title="Engine Watchdog Telemetry"
              >
                WATCHDOG TELEMETRY
              </div>
              <div className="divide-y divide-slate-800 text-xs">
                {[
                  { label: 'SUPERVISION', val: 'Decoupled Audio Core + UI' },
                  {
                    label: 'ENGINE RATE',
                    val: telemetry.isRunning
                      ? `${telemetry.sampleRate} Hz (Running)`
                      : `${sampleRate} Hz (Standby)`,
                  },
                  { label: 'BUFFER QTM', val: `${bufferSize} samples (${latencyMs} ms)` },
                  { label: 'CLIP EVENTS', val: `${telemetry.clippingEvents} events` },
                  {
                    label: 'PERSISTENCE',
                    val: 'Atomic JSON Store (tmp+rename, SHA1 dedup) + WS Sync',
                  },
                ].map((row) => (
                  <div key={row.label} className="py-2.5 flex items-center justify-between">
                    <span className="text-slate-400">{row.label}</span>
                    <span className="font-mono text-slate-100 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      {row.val}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="lg:col-span-7 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-3">
              <div
                className="font-mono text-xs font-semibold text-white uppercase border-b border-slate-800 pb-2 hw-engraved"
                title="Configuration & System Audit Trail"
              >
                AUDIT TRAIL
              </div>
              <div className="divide-y divide-slate-800 max-h-72 overflow-y-auto">
                {auditEvents.map((evt) => (
                  <div key={evt.id} className="py-2.5 flex items-start justify-between gap-4 text-xs">
                    <div className="space-y-0.5">
                      <div className="font-semibold text-white">{evt.action}</div>
                      <div className="text-slate-400">{evt.detail}</div>
                    </div>
                    <div className="text-right font-mono text-[10px] text-slate-500 shrink-0">
                      <div>{evt.actor}</div>
                      <div>{new Date(evt.timestamp).toLocaleTimeString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Support Log — the in-memory flight recorder (errors, warnings and
              key system events captured this session). This is what support
              asks for first when something went wrong mid-service. */}
          <SupportLogPanel />
        </div>
      )}
    </div>
  );
};
