import React, { useState } from 'react';
import { Mic, RefreshCw, Plus, ChevronLeft, ChevronRight, Activity, ArrowRight } from 'lucide-react';
import type { InputChannel } from '../types/audio.ts';
import { deriveAutoChannelNameAndRole } from '../utils/audioNaming.ts';

interface InputSourcesDrawerProps {
  inputDevices: MediaDeviceInfo[];
  channels: InputChannel[];
  onUpdateChannel: (id: string, patch: Partial<InputChannel>) => void;
  onAddChannel?: (name?: string, role?: string) => void;
  onScanAudioDevices?: (requestPermission?: boolean) => Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>;
  selectedChannelId?: string;
  onSelectChannel?: (channelId: string) => void;
}

export const InputSourcesDrawer: React.FC<InputSourcesDrawerProps> = ({
  inputDevices,
  channels,
  onUpdateChannel,
  onAddChannel,
  onScanAudioDevices,
  selectedChannelId,
  onSelectChannel,
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

  const classifyDevice = (label: string) => {
    const l = label.toLowerCase();
    if (l.includes('cable') || l.includes('virtual') || l.includes('loopback')) return { kind: 'Virtual Cable', color: 'text-emerald-400 bg-emerald-950/40 border-emerald-500/30' };
    if (l.includes('usb') || l.includes('focusrite') || l.includes('behringer') || l.includes('yamaha') || l.includes('scarlett') || l.includes('mg')) return { kind: 'USB Interface', color: 'text-sky-400 bg-sky-950/40 border-sky-500/30' };
    if (l.includes('line') || l.includes('aux')) return { kind: 'Line In', color: 'text-violet-400 bg-violet-950/40 border-violet-500/30' };
    return { kind: 'Mic / Input', color: 'text-amber-400 bg-amber-950/40 border-amber-500/30' };
  };

  if (collapsed) {
    return (
      <div className="shrink-0 w-8 bg-[#090D15] border-r border-slate-800 flex flex-col items-center py-2.5 justify-between">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Open Available Inputs Dock"
          className="p-1 rounded hover:bg-slate-800 text-sky-400 hover:text-white transition cursor-pointer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <div className="[writing-mode:vertical-rl] rotate-180 font-mono text-[10px] text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
          <Mic className="w-3 h-3 text-sky-400" />
          <span>Live Inputs ({inputDevices.length})</span>
        </div>
        <span className="hw-lamp" data-on="green" style={{ width: 6, height: 6 }} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="shrink-0 w-64 bg-[#090D15] border-r border-slate-800 flex flex-col justify-between overflow-hidden">
      {/* Header */}
      <div className="p-2.5 border-b border-slate-800 flex items-center justify-between gap-1.5 bg-[#0C121E]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Mic className="w-4 h-4 text-sky-400 shrink-0" />
          <span className="font-mono text-xs font-bold text-white truncate hw-engraved !text-white">
            Live Inputs ({inputDevices.length})
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            disabled={scanning}
            onClick={() => void handleScan()}
            title="Live Rescan All Input Devices (USB, soundcard & virtual cables incl. VB-Audio)"
            aria-label="Live rescan input devices"
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
            title="Collapse Inputs Panel"
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Device List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {inputDevices.length === 0 ? (
          <div
            className="p-3 flex items-center justify-center gap-1.5 border border-dashed border-slate-800 rounded bg-[#060910] text-[10px] font-mono text-slate-500 uppercase tracking-wider"
            title="No external audio inputs detected yet. Click Rescan (grants mic access once to unlock labels) or plug in a USB / virtual cable device."
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
            const { kind, color } = classifyDevice(dev.label || '');
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

                {/* Assigned Channels Badge List */}
                <div className="flex items-center justify-between text-[10px] font-mono pt-0.5">
                  <span className="text-slate-400 uppercase tracking-wider">Mapped:</span>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    {assignedChannels.length === 0 ? (
                      <span className="text-slate-500 uppercase text-[9px] tracking-wider">Unassigned</span>
                    ) : (
                      assignedChannels.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => onSelectChannel?.(c.id)}
                          className={`px-1 rounded text-[9px] font-bold border transition ${
                            selectedChannelId === c.id
                              ? 'bg-sky-500 text-slate-950 border-sky-300'
                              : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500'
                          }`}
                        >
                          CH{c.index}
                        </button>
                      ))
                    )}
                  </div>
                </div>

                {/* 1-Click Quick Assignment to Focused / Selected Channel */}
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
                    title="Route → Selected Strip"
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

      {/* Footer Add Channel Button */}
      {onAddChannel && (
        <div className="p-2 border-t border-slate-800 bg-[#0C121E]">
          <button
            type="button"
            onClick={() => onAddChannel()}
            className="w-full py-1.5 rounded border border-emerald-500/50 bg-emerald-500/20 hover:bg-emerald-500/35 text-emerald-200 font-mono text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer shadow-sm uppercase tracking-wider"
            title="Add Channel Strip"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Strip</span>
          </button>
        </div>
      )}
    </div>
  );
};
