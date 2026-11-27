import React, { useState } from 'react';
import {
  Mic,
  Volume2,
  RefreshCw,
  Plus,
  ChevronLeft,
  ChevronRight,
  Headphones,
  Radio,
  Speaker,
  Check,
  ArrowRight,
} from 'lucide-react';
import type { InputChannel, SpeakerZone, SignalTelemetry } from '../types/audio.ts';
import { deriveAutoChannelNameAndRole } from '../utils/audioNaming.ts';

interface LivePatchbayDrawerProps {
  side?: 'left' | 'right';
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  channels: InputChannel[];
  selectedChannelId?: string;
  preferredOutputDeviceId?: string;
  preferredStreamOutputDeviceId?: string;
  zones?: SpeakerZone[];
  telemetry?: SignalTelemetry;
  onUpdateChannel: (id: string, patch: Partial<InputChannel>) => void;
  onSelectChannel?: (channelId: string) => void;
  onAddChannel?: (name?: string, role?: string) => void;
  onSelectOutputDevice?: (deviceId: string) => void;
  onSelectStreamOutputDevice?: (deviceId: string) => void;
  onUpdateZone?: (id: string, patch: Partial<SpeakerZone>) => void;
  onScanAudioDevices?: (requestPermission?: boolean) => Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>;
  initialTab?: 'inputs' | 'outputs';
}

export const LivePatchbayDrawer: React.FC<LivePatchbayDrawerProps> = ({
  side = 'left',
  inputDevices = [],
  outputDevices = [],
  channels = [],
  selectedChannelId,
  preferredOutputDeviceId = '',
  preferredStreamOutputDeviceId = '',
  zones = [],
  telemetry,
  onUpdateChannel,
  onSelectChannel,
  onAddChannel,
  onSelectOutputDevice,
  onSelectStreamOutputDevice,
  onUpdateZone,
  onScanAudioDevices,
  initialTab = 'inputs',
}) => {
  const [activeTab, setActiveTab] = useState<'inputs' | 'outputs'>(initialTab);
  const [collapsed, setCollapsed] = useState(false);
  const [scanning, setScanning] = useState(false);

  const isLeft = side === 'left';
  const borderClass = isLeft ? 'border-r border-slate-800' : 'border-l border-slate-800';

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
    if (l.includes('cable') || l.includes('virtual') || l.includes('loopback')) {
      return { kind: 'Virtual Cable', color: 'text-emerald-400 bg-emerald-950/40 border-emerald-500/30' };
    }
    if (
      l.includes('usb') ||
      l.includes('focusrite') ||
      l.includes('behringer') ||
      l.includes('yamaha') ||
      l.includes('scarlett') ||
      l.includes('mg')
    ) {
      return { kind: 'USB Interface', color: 'text-sky-400 bg-sky-950/40 border-sky-500/30' };
    }
    if (l.includes('line') || l.includes('aux')) {
      return { kind: 'Line In', color: 'text-violet-400 bg-violet-950/40 border-violet-500/30' };
    }
    return { kind: 'Mic / Input', color: 'text-amber-400 bg-amber-950/40 border-amber-500/30' };
  };

  const classifyOutput = (label: string) => {
    const l = label.toLowerCase();
    if (l.includes('cable') || l.includes('virtual') || l.includes('voicemeeter') || l.includes('obs')) {
      return { kind: 'Virtual / OBS Ingest', color: 'text-violet-400 bg-violet-950/40 border-violet-500/30', icon: Radio };
    }
    if (l.includes('headphone') || l.includes('earphone') || l.includes('bluetooth') || l.includes('buds')) {
      return { kind: 'Headphones / Cue', color: 'text-sky-400 bg-sky-950/40 border-sky-500/30', icon: Headphones };
    }
    if (l.includes('usb') || l.includes('interface') || l.includes('scarlett') || l.includes('behringer') || l.includes('yamaha')) {
      return { kind: 'USB Interface Out', color: 'text-amber-400 bg-amber-950/40 border-amber-500/30', icon: Speaker };
    }
    return { kind: 'Main PA / Speakers', color: 'text-emerald-400 bg-emerald-950/40 border-emerald-500/30', icon: Speaker };
  };

  const postLevel = telemetry?.postRmsDb ?? -60;
  const meterWidth = Math.max(0, Math.min(100, ((postLevel + 60) / 60) * 100));

  // Collapsed Sidebar View
  if (collapsed) {
    return (
      <div className={`shrink-0 w-8 bg-[#090D15] ${borderClass} flex flex-col items-center py-2.5 justify-between select-none`}>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Expand Live I/O Patchbay"
          className="p-1 rounded hover:bg-slate-800 text-sky-400 hover:text-white transition cursor-pointer"
        >
          {isLeft ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>

        <div className="flex flex-col items-center gap-4">
          <button
            type="button"
            onClick={() => {
              setActiveTab('inputs');
              setCollapsed(false);
            }}
            title={`Switch to Live Inputs (${inputDevices.length})`}
            className={`p-1.5 rounded transition cursor-pointer ${
              activeTab === 'inputs'
                ? 'bg-sky-500/20 text-sky-400 border border-sky-500/40'
                : 'text-slate-500 hover:text-slate-300'
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
            title={`Switch to Live Outputs (${outputDevices.length})`}
            className={`p-1.5 rounded transition cursor-pointer ${
              activeTab === 'outputs'
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={`shrink-0 w-72 bg-[#090D15] ${borderClass} flex flex-col justify-between overflow-hidden select-none`}>
      {/* Top Header: Interchangeable Tabs + Scan Button + Collapse */}
      <div className="p-2 border-b border-slate-800 bg-[#0C121E] space-y-1.5">
        <div className="flex items-center justify-between gap-1">
          {/* Interchangeable Tab Selectors */}
          <div className="grid grid-cols-2 gap-1 flex-1 font-mono text-[10px] font-bold">
            <button
              type="button"
              onClick={() => setActiveTab('inputs')}
              className={`py-1 px-2 rounded border-2 transition cursor-pointer flex items-center justify-center gap-1.5 hw-key ${
                activeTab === 'inputs'
                  ? '!bg-none !bg-sky-500 !border-sky-300 !text-slate-950 shadow-[0_0_8px_rgba(56,189,248,0.4)]'
                  : ''
              }`}
            >
              <Mic className="w-3 h-3 shrink-0" />
              <span>INPUTS ({inputDevices.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('outputs')}
              className={`py-1 px-2 rounded border-2 transition cursor-pointer flex items-center justify-center gap-1.5 hw-key ${
                activeTab === 'outputs'
                  ? '!bg-none !bg-emerald-500 !border-emerald-300 !text-slate-950 shadow-[0_0_8px_rgba(52,211,153,0.4)]'
                  : ''
              }`}
            >
              <Volume2 className="w-3 h-3 shrink-0" />
              <span>OUTPUTS ({outputDevices.length})</span>
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-0.5 shrink-0 pl-1">
            <button
              type="button"
              disabled={scanning}
              onClick={() => void handleScan()}
              title="Live Rescan Physical & Virtual Audio Ports (inputs + outputs)"
              aria-label="Live rescan audio ports"
              className={`px-1.5 py-1 rounded border font-mono text-[9px] font-bold flex items-center gap-1 transition cursor-pointer disabled:opacity-40 hw-key ${
                scanning
                  ? '!bg-none !bg-sky-950/50 !border-sky-400/70 !text-sky-300'
                  : '!bg-none !bg-sky-950/35 !border-sky-500/45 !text-sky-300 hover:!bg-sky-900/50'
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin' : ''}`} />
              <span>{scanning ? 'Scanning…' : 'Rescan'}</span>
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="Collapse Side Dock"
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
            >
              {isLeft ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* =========================================================================
          TAB CONTENT: LIVE INPUT CHANNELS
          ========================================================================= */}
      {activeTab === 'inputs' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
          {inputDevices.length === 0 ? (
            <div
              className="p-3 flex items-center justify-center gap-1.5 border border-dashed border-slate-800 rounded bg-[#060910] text-[10px] font-mono text-slate-500 uppercase tracking-wider"
              title="No audio inputs detected. Click refresh or plug in USB audio device."
            >
              <span
                aria-hidden="true"
                className="hw-lamp"
                style={{ width: 6, height: 6 }}
              />
              NO INPUTS · RESCAN
            </div>
          ) : (
            inputDevices.map((dev, idx) => {
              const { kind, color } = classifyInput(dev.label || '');
              const assignedChannels = channels.filter(
                (c) => c.hardwareInputId === dev.deviceId
              );
              return (
                <div
                  key={`in-card-${dev.deviceId}-${idx}`}
                  className="p-2 rounded border border-slate-800/90 bg-[#0E1422] space-y-1.5 hover:border-slate-700 transition"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${color}`}>
                      {kind}
                    </span>
                    <div className="flex items-center gap-1">
                      <span
                        aria-hidden="true"
                        className="hw-lamp"
                        data-on="green"
                        style={{ width: 5, height: 5 }}
                      />
                      <span className="font-mono text-[9px] text-emerald-400 uppercase font-semibold">Active</span>
                    </div>
                  </div>

                  <div
                    className="font-mono text-[11px] font-bold text-white truncate"
                    title={dev.label || `Audio Input ${idx + 1}`}
                  >
                    {dev.label || `Audio Input ${idx + 1}`}
                  </div>

                  {/* Assigned Channel Strips */}
                  <div className="flex items-center justify-between text-[10px] font-mono pt-0.5">
                    <span className="text-slate-400">Mapped:</span>
                    <div className="flex items-center gap-1 flex-wrap justify-end">
                      {assignedChannels.length === 0 ? (
                        <span className="text-slate-500 uppercase text-[9px] tracking-wider">Unassigned</span>
                      ) : (
                        assignedChannels.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => onSelectChannel?.(c.id)}
                            className={`px-1.5 py-0.5 rounded text-[9px] font-bold border transition ${
                              selectedChannelId === c.id
                                ? 'bg-sky-500 text-slate-950 border-sky-300'
                                : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500'
                            }`}
                          >
                            CH{c.index} · {c.name}
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  {/* 1-Click Route to Focused Channel Strip */}
                  {selectedChannelId && (
                    <button
                      type="button"
                      onClick={() => {
                        const targetCh = channels.find((c) => c.id === selectedChannelId);
                        const auto = deriveAutoChannelNameAndRole(
                          dev.label || `Audio Input ${idx + 1}`,
                          targetCh?.index ?? 1
                        );
                        onUpdateChannel(selectedChannelId, {
                          hardwareInputId: dev.deviceId,
                          hardwareInputLabel: dev.label || `Audio Input ${idx + 1}`,
                          name: auto.name,
                          role: auto.role,
                        });
                      }}
                      className="w-full mt-1 py-1 rounded bg-[#131B2E] hover:bg-sky-500/20 border border-slate-700 hover:border-sky-400/60 font-mono text-[9px] font-semibold text-slate-300 hover:text-sky-200 transition flex items-center justify-center gap-1 cursor-pointer uppercase tracking-wider"
                      title="Route → Focused Channel"
                    >
                      <span>Route</span>
                      <ArrowRight className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* =========================================================================
          TAB CONTENT: LIVE OUTPUT DESTINATIONS & PCIE DISCRETE JACKS
          ========================================================================= */}
      {activeTab === 'outputs' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
          {outputDevices.length === 0 ? (
            <div
              className="p-3 flex items-center justify-center gap-1.5 border border-dashed border-slate-800 rounded bg-[#060910] text-[10px] font-mono text-slate-500 uppercase tracking-wider"
              title="No audio output endpoints detected. Click refresh or plug in speakers/headphones."
            >
              <span
                aria-hidden="true"
                className="hw-lamp"
                style={{ width: 6, height: 6 }}
              />
              NO OUTPUTS · RESCAN
            </div>
          ) : (
            outputDevices.map((dev, idx) => {
              const { kind, color, icon: DeviceIcon } = classifyOutput(dev.label || '');
              const isMasterOut = preferredOutputDeviceId ? dev.deviceId === preferredOutputDeviceId : idx === 0;
              const isStreamOut = dev.deviceId === preferredStreamOutputDeviceId;
              const assignedZones = zones.filter((z) => z.hardwareOutputId === dev.deviceId);

              return (
                <div
                  key={`out-card-${dev.deviceId}-${idx}`}
                  className={`p-2 rounded border space-y-1.5 transition ${
                    isMasterOut
                      ? 'border-emerald-500/70 bg-[#0A1616] shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                      : isStreamOut
                        ? 'border-violet-500/70 bg-[#140C20]'
                        : 'border-slate-800/90 bg-[#0E1422] hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border flex items-center gap-1 ${color}`}>
                      <DeviceIcon className="w-2.5 h-2.5" />
                      <span>{kind}</span>
                    </span>
                    <div className="flex items-center gap-1">
                      <span
                        aria-hidden="true"
                        className="hw-lamp"
                        data-on="green"
                        style={{ width: 5, height: 5 }}
                      />
                      <span className="font-mono text-[9px] text-emerald-400 uppercase font-semibold">Active</span>
                    </div>
                  </div>

                  <div
                    className="font-mono text-[11px] font-bold text-white truncate"
                    title={dev.label || `Audio Output ${idx + 1}`}
                  >
                    {dev.label || `Audio Output ${idx + 1}`}
                  </div>

                  {/* Active Routing Tags */}
                  <div className="flex items-center gap-1 flex-wrap font-mono text-[9px]">
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
                        className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 truncate max-w-[120px]"
                        title={`Speaker Zone: ${z.name}`}
                      >
                        {z.name}
                      </span>
                    ))}
                    {!isMasterOut && !isStreamOut && assignedZones.length === 0 && (
                      <span
                        className="text-slate-500 uppercase text-[9px] tracking-wider"
                        title="Available for assignment"
                      >
                        Open
                      </span>
                    )}
                  </div>

                  {/* Live Output Signal Meter (if active master or stream bus) */}
                  {(isMasterOut || isStreamOut) && (
                    <div className="space-y-0.5 pt-0.5">
                      <div className="flex items-center justify-between text-[8px] font-mono text-slate-400">
                        <span className="uppercase tracking-wider">OUT LEVEL</span>
                        <span className="text-emerald-400 font-bold tabular-nums">
                          {telemetry?.isRunning ? `${postLevel.toFixed(1)} dBFS` : 'IDLE'}
                        </span>
                      </div>
                      <div className="hw-led-track-h h-2 w-full rounded-xs" title={`Output level ${postLevel.toFixed(1)} dBFS`}>
                        {Array.from({ length: 12 }).map((_, i) => {
                          const lit = meterWidth >= ((i + 1) / 12) * 100;
                          const color = i / 12 >= 0.85 ? 'red' : i / 12 >= 0.68 ? 'amber' : 'green';
                          return (
                            <span
                              key={i}
                              aria-hidden="true"
                              className="hw-led-seg"
                              data-lit={lit ? color : undefined}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Selective Route Action Buttons */}
                  <div className="grid grid-cols-2 gap-1 pt-1">
                    {onSelectOutputDevice && (
                      <button
                        type="button"
                        onClick={() => onSelectOutputDevice(dev.deviceId)}
                        className={`py-1 rounded font-mono text-[9px] font-semibold border transition cursor-pointer uppercase tracking-wider hw-key ${
                          isMasterOut
                            ? '!bg-none !bg-emerald-600 !border-emerald-400 !text-white shadow-[0_0_6px_rgba(16,185,129,0.45)]'
                            : '!text-slate-300 hover:!text-white hover:!border-emerald-500/50'
                        }`}
                        title={isMasterOut ? 'Master PA output' : 'Set Master PA'}
                      >
                        {isMasterOut ? '✓ Master PA' : 'Master PA'}
                      </button>
                    )}

                    {onSelectStreamOutputDevice && (
                      <button
                        type="button"
                        onClick={() => onSelectStreamOutputDevice(dev.deviceId)}
                        className={`py-1 rounded font-mono text-[9px] font-semibold border transition cursor-pointer uppercase tracking-wider hw-key ${
                          isStreamOut
                            ? '!bg-none !bg-violet-600 !border-violet-400 !text-white shadow-[0_0_6px_rgba(139,92,246,0.45)]'
                            : '!text-slate-300 hover:!text-white hover:!border-violet-500/50'
                        }`}
                        title={isStreamOut ? 'Stream / OBS output' : 'Set Stream OBS'}
                      >
                        {isStreamOut ? '✓ Stream OBS' : 'Stream OBS'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Footer Area */}
      <div className="p-2 border-t border-slate-800 bg-[#0C121E]">
        {activeTab === 'inputs' && onAddChannel ? (
          <button
            type="button"
            onClick={() => onAddChannel()}
            className="w-full py-1.5 rounded border border-emerald-500/50 bg-emerald-500/20 hover:bg-emerald-500/35 text-emerald-200 font-mono text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer shadow-sm uppercase tracking-wider"
            title="Add Channel Strip"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Strip</span>
          </button>
        ) : (
          <div className="font-mono text-[9px] text-slate-400 flex items-center justify-between uppercase tracking-wider">
            <span title="Standalone stereo outputs">Stereo Outs</span>
            <span className="text-emerald-400 font-bold">100% Live Sync</span>
          </div>
        )}
      </div>
    </div>
  );
};
