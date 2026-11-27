import React, { useState } from 'react';
import { Volume2, RefreshCw, ChevronLeft, ChevronRight, Headphones, Radio, Speaker, Check } from 'lucide-react';
import type { SpeakerZone, SignalTelemetry } from '../types/audio.ts';

interface OutputDestinationsDrawerProps {
  outputDevices: MediaDeviceInfo[];
  preferredOutputDeviceId?: string;
  preferredStreamOutputDeviceId?: string;
  onSelectOutputDevice?: (deviceId: string) => void;
  onSelectStreamOutputDevice?: (deviceId: string) => void;
  zones?: SpeakerZone[];
  onUpdateZone?: (id: string, patch: Partial<SpeakerZone>) => void;
  telemetry?: SignalTelemetry;
  onScanAudioDevices?: (requestPermission?: boolean) => Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>;
}

export const OutputDestinationsDrawer: React.FC<OutputDestinationsDrawerProps> = ({
  outputDevices = [],
  preferredOutputDeviceId = '',
  preferredStreamOutputDeviceId = '',
  onSelectOutputDevice,
  onSelectStreamOutputDevice,
  zones = [],
  onUpdateZone,
  telemetry,
  onScanAudioDevices,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [scanning, setScanning] = useState(false);

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
    return { kind: 'Main / Speakers', color: 'text-emerald-400 bg-emerald-950/40 border-emerald-500/30', icon: Speaker };
  };

  const postLevel = telemetry?.postRmsDb ?? -60;
  const meterWidth = Math.max(0, Math.min(100, ((postLevel + 60) / 60) * 100));

  if (collapsed) {
    return (
      <div className="shrink-0 w-8 bg-[#090D15] border-l border-slate-800 flex flex-col items-center py-2.5 justify-between">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Open Live Outputs Dock"
          className="p-1 rounded hover:bg-slate-800 text-emerald-400 hover:text-white transition cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="[writing-mode:vertical-rl] font-mono text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
          <Volume2 className="w-3 h-3 text-emerald-400" />
          <span>Live Outputs ({outputDevices.length})</span>
        </div>
        <span className="hw-lamp" data-on="green" style={{ width: 6, height: 6 }} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="shrink-0 w-64 bg-[#090D15] border-l border-slate-800 flex flex-col justify-between overflow-hidden">
      {/* Header */}
      <div className="p-2.5 border-b border-slate-800 flex items-center justify-between gap-1.5 bg-[#0C121E]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Volume2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="font-mono text-xs font-bold text-white truncate hw-engraved !text-white">
            Live Outputs ({outputDevices.length})
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={scanning}
            onClick={() => void handleScan()}
            title="Live Rescan All Output Devices (speakers, headphones, USB & virtual cable sinks)"
            aria-label="Live rescan output devices"
            className={`px-1.5 py-1 rounded border font-mono text-[9px] font-bold flex items-center gap-1 transition cursor-pointer disabled:opacity-40 hw-key ${
              scanning
                ? '!bg-none !bg-emerald-950/50 !border-emerald-400/70 !text-emerald-300'
                : '!bg-none !bg-emerald-950/35 !border-emerald-500/45 !text-emerald-300 hover:!bg-emerald-900/50'
            }`}
          >
            <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin' : ''}`} />
            <span>{scanning ? 'Scanning…' : 'Rescan'}</span>
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse Outputs Panel"
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Output Device List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {outputDevices.length === 0 ? (
          <div
            className="p-3 flex items-center justify-center gap-1.5 border border-dashed border-slate-800 rounded bg-[#060910] text-[10px] font-mono text-slate-500 uppercase tracking-wider"
            title="No audio output endpoints detected. Click refresh or plug in headphones/speakers."
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
                {/* Kind Badge + Live Activity */}
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

                {/* Device Title */}
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

      {/* Footer Info */}
      <div className="p-2 border-t border-slate-800 bg-[#0C121E] font-mono text-[9px] text-slate-400 flex items-center justify-between uppercase tracking-wider">
        <span title="Selective output bus matrix">Bus · Sel Out</span>
        <span className="text-emerald-400 font-bold">100% Live Sync</span>
      </div>
    </div>
  );
};
