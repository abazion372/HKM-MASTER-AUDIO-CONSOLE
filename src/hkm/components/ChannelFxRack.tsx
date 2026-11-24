import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Power, RotateCcw, Music4 } from 'lucide-react';
import type { ChannelFxRackState, FxSlotId, InputChannel } from '../types/audio.ts';
import {
  countEngagedFx,
  defaultFxRackState,
  FX_CHAIN_ORDER,
  FX_EFFECTS,
  type FxParamDef,
} from '../audio/fx/fxDefinition.ts';

interface ChannelFxRackPanelProps {
  channel: InputChannel;
  engineRunning: boolean;
  onUpdateChannelFx: (channelId: string, updater: (rack: ChannelFxRackState) => ChannelFxRackState) => void;
}

const ACCENT_LED: Record<string, string> = {
  slate: 'bg-slate-300 shadow-[0_0_6px_rgba(203,213,225,0.8)]',
  amber: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
  violet: 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.8)]',
  emerald: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]',
  cyan: 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]',
  rose: 'bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.8)]',
};

const ACCENT_RANGE: Record<string, string> = {
  slate: 'accent-slate-300',
  amber: 'accent-amber-400',
  violet: 'accent-violet-400',
  emerald: 'accent-emerald-400',
  cyan: 'accent-cyan-400',
  rose: 'accent-rose-400',
};

function formatParamValue(def: FxParamDef, value: number): string {
  if (def.options) {
    return def.options[Math.round(value)] ?? def.options[0];
  }
  const decimals = def.step && def.step >= 1 ? 0 : def.step && def.step >= 0.1 ? 1 : 2;
  const shown = value.toFixed(decimals);
  return def.unit ? `${shown} ${def.unit}` : shown;
}

/**
 * Guitar FX Rack panel — the real-world pedalboard for one input channel.
 * Twelve stompbox slots in canonical chain order; stomping a chip engages the
 * pedal into the channel's insert and opens its knob panel below.
 */
export const ChannelFxRackPanel: React.FC<ChannelFxRackPanelProps> = ({
  channel,
  engineRunning,
  onUpdateChannelFx,
}) => {
  const [openSlot, setOpenSlot] = useState<FxSlotId | null>(null);
  const tapTempoRef = useRef<number[]>([]);

  const rack = useMemo(
    () => channel.fxRack ?? defaultFxRackState(),
    [channel.fxRack]
  );
  const engagedCount = countEngagedFx(rack);

  const patchSlot = useCallback(
    (slotId: FxSlotId, slotPatch: Partial<{ engaged: boolean; params: Record<string, number> }>) => {
      onUpdateChannelFx(channel.id, (prev) => ({
        ...prev,
        slots: {
          ...prev.slots,
          [slotId]: { ...prev.slots[slotId], ...slotPatch },
        },
      }));
    },
    [channel.id, onUpdateChannelFx]
  );

  const setParam = useCallback(
    (slotId: FxSlotId, paramId: string, value: number) => {
      onUpdateChannelFx(channel.id, (prev) => ({
        ...prev,
        slots: {
          ...prev.slots,
          [slotId]: {
            ...prev.slots[slotId],
            params: { ...prev.slots[slotId].params, [paramId]: value },
          },
        },
      }));
    },
    [channel.id, onUpdateChannelFx]
  );

  const resetSlot = useCallback(
    (slotId: FxSlotId) => {
      const def = FX_EFFECTS[slotId];
      const params: Record<string, number> = {};
      for (const p of def.params) params[p.id] = p.default;
      patchSlot(slotId, { params });
    },
    [patchSlot]
  );

  const handleTapTempo = useCallback(() => {
    const now = performance.now();
    const taps = tapTempoRef.current.filter((t) => now - t < 2500);
    taps.push(now);
    tapTempoRef.current = taps.slice(-4);
    if (tapTempoRef.current.length >= 2) {
      const deltas: number[] = [];
      for (let i = 1; i < tapTempoRef.current.length; i++) {
        deltas.push(tapTempoRef.current[i] - tapTempoRef.current[i - 1]);
      }
      const avgMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const bpm = Math.round(Math.min(240, Math.max(40, 60000 / avgMs)));
      setParam('delay', 'bpm', bpm);
    }
  }, [setParam]);

  const openDef = openSlot ? FX_EFFECTS[openSlot] : null;
  const openSlotState = openSlot ? rack.slots[openSlot] : null;

  return (
    <div className="rounded-md border border-[#2A3646] bg-gradient-to-b from-[#101820] to-[#0B1118] shrink-0 overflow-hidden">
      {/* Rack header: master bypass + engaged counter */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#1E2A38]">
        <div className="flex items-center gap-1.5 min-w-0">
          <Music4 className="w-3.5 h-3.5 text-teal-300 shrink-0" />
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-slate-300 truncate">
            FX Rack · Pedalboard
          </span>
          <span
            className={`font-mono text-[8.5px] px-1.5 py-px rounded border shrink-0 ${
              rack.enabled
                ? 'border-teal-400/50 bg-teal-500/15 text-teal-300'
                : 'border-slate-700 bg-slate-800/40 text-slate-500'
            }`}
            title="Engaged pedals"
          >
            {engagedCount}/12
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={rack.enabled}
          title={rack.enabled ? 'FX Rack engaged — click to bypass the whole pedalboard' : 'FX Rack bypassed — click to engage'}
          onClick={() =>
            onUpdateChannelFx(channel.id, (prev) => ({ ...prev, enabled: !prev.enabled }))
          }
          className={`h-6 px-2 rounded border font-mono text-[9px] font-bold tracking-[0.14em] transition cursor-pointer flex items-center gap-1 ${
            rack.enabled
              ? 'bg-teal-500/25 border-teal-400/70 text-teal-200 shadow-[0_0_8px_rgba(45,212,191,0.3)]'
              : 'bg-[#0A0E14] border-[#2A3544] text-slate-500 hover:text-slate-300'
          }`}
        >
          <Power className="w-3 h-3" />
          {rack.enabled ? 'FX ON' : 'BYPASS'}
        </button>
      </div>

      {/* Pedal chips in canonical chain order — stomp to engage */}
      <div
        className="grid grid-cols-4 gap-1 p-1.5"
        role="toolbar"
        aria-label={`Guitar FX pedals for channel ${channel.index}`}
      >
        {FX_CHAIN_ORDER.map((slotId) => {
          const def = FX_EFFECTS[slotId];
          const slot = rack.slots[slotId];
          const engaged = rack.enabled && slot.engaged;
          const isOpen = openSlot === slotId;
          return (
            <button
              key={slotId}
              type="button"
              title={`${def.name} — ${def.archetype}\n${def.description}`}
              aria-pressed={engaged}
              onClick={() => {
                const nextOpen = isOpen ? null : slotId;
                setOpenSlot(nextOpen);
                if (nextOpen) {
                  // Stomping the pedal engages it (and the rack) like a real footswitch.
                  if (!slot.engaged) patchSlot(slotId, { engaged: true });
                  if (!rack.enabled) {
                    onUpdateChannelFx(channel.id, (prev) => ({ ...prev, enabled: true }));
                  }
                }
              }}
              className={`relative h-7 rounded border font-mono text-[8.5px] font-bold tracking-wide transition-all cursor-pointer flex items-center justify-center gap-1 overflow-hidden ${
                engaged
                  ? 'border-[#5EEAD4]/60 bg-gradient-to-b from-[#1B3138] to-[#122028] text-teal-100'
                  : 'border-[#2A3644] bg-[#0A0F16] text-slate-500 hover:text-slate-200 hover:border-[#3E5166]'
              } ${isOpen ? 'ring-1 ring-[#5EEAD4]/50' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full shrink-0 transition-all ${
                  engaged ? ACCENT_LED[def.accent] : 'bg-slate-700'
                }`}
              />
              <span className="truncate">{def.short}</span>
            </button>
          );
        })}
      </div>

      {/* Knob panel of the opened pedal */}
      {openDef && openSlotState && (
        <div className="border-t border-[#1E2A38] bg-[#080D13]/70 p-2 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[10px] font-bold text-slate-200 truncate">
                {openDef.name}
                <span className="text-slate-500 font-normal"> · {openDef.archetype}</span>
              </div>
              <div className="text-[8.5px] text-slate-500 leading-tight mt-0.5 truncate" title={openDef.description}>
                {openDef.description}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                title="Reset knobs to real-world defaults"
                onClick={() => resetSlot(openSlot!)}
                className="h-6 w-7 rounded border border-[#2A3644] bg-[#0A0F16] text-slate-500 hover:text-slate-200 flex items-center justify-center cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={openSlotState.engaged}
                title={openSlotState.engaged ? 'Disengage pedal' : 'Engage pedal'}
                onClick={() => patchSlot(openSlot!, { engaged: !openSlotState.engaged })}
                className={`h-6 px-2 rounded border font-mono text-[9px] font-bold tracking-[0.14em] transition cursor-pointer flex items-center gap-1 ${
                  openSlotState.engaged
                    ? 'bg-teal-500/25 border-teal-400/70 text-teal-200'
                    : 'bg-[#0A0E14] border-[#2A3544] text-slate-500 hover:text-slate-300'
                }`}
              >
                <Power className="w-3 h-3" />
                {openSlotState.engaged ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 max-h-44 overflow-y-auto pr-1">
            {openDef.params.map((def) => {
              const value = openSlotState.params[def.id] ?? def.default;
              return (
                <div key={def.id} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[8px] uppercase tracking-wider text-slate-500 truncate">
                      {def.label}
                    </span>
                    <span className="font-mono text-[9px] font-bold tabular-nums text-slate-300 shrink-0">
                      {formatParamValue(def, value)}
                    </span>
                  </div>
                  {def.options ? (
                    <div className="flex gap-1" role="radiogroup" aria-label={def.label}>
                      {def.options.map((label, idx) => (
                        <button
                          key={label}
                          type="button"
                          role="radio"
                          aria-checked={Math.round(value) === idx}
                          onClick={() => setParam(openSlot!, def.id, idx)}
                          className={`flex-1 h-5 rounded border font-mono text-[8px] font-bold transition cursor-pointer truncate px-1 ${
                            Math.round(value) === idx
                              ? 'bg-[#5EEAD4]/20 border-[#5EEAD4]/60 text-teal-200'
                              : 'bg-[#0A0F16] border-[#2A3644] text-slate-500 hover:text-slate-200'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="range"
                      min={def.min}
                      max={def.max}
                      step={def.step ?? 0.01}
                      value={value}
                      aria-label={def.label}
                      onChange={(e) => setParam(openSlot!, def.id, parseFloat(e.target.value))}
                      className={`w-full h-1.5 cursor-pointer ${ACCENT_RANGE[openDef.accent]}`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Tap tempo — the worship guitarist's dotted-eighth companion */}
          {openSlot === 'delay' && (
            <button
              type="button"
              onClick={handleTapTempo}
              title="Tap 2–4 beats to set the delay tempo"
              className="h-7 rounded border border-cyan-400/60 bg-cyan-500/15 text-cyan-200 font-mono text-[9px] font-bold tracking-[0.2em] cursor-pointer hover:bg-cyan-500/25 transition"
            >
              TAP TEMPO · {Math.round(openSlotState.params.bpm ?? 100)} BPM
            </button>
          )}

          {engineRunning && !rack.enabled && (
            <div className="text-[8.5px] text-amber-400/80 font-mono">
              Pedals are armed — switch the rack ON to hear them.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
