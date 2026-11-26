import React from 'react';
import { X, Mic2, Play, Smartphone, ShieldCheck, BookOpen } from 'lucide-react';

interface FirstRunGuideProps {
  onDismiss: () => void;
}

/**
 * One-time orientation strip for fresh installs.
 *
 * The console boots into a fully-populated sample setup (venue, channels,
 * zones) so nothing looks broken on first launch — but without this strip a
 * new operator has no way to tell the sample data from real configuration.
 * Non-modal, dismissible, and shown exactly once (persisted via
 * `firstRunCompleted` in the state store, so it survives reinstalls of the
 * app but not resets of the saved state).
 */
export const FirstRunGuide: React.FC<FirstRunGuideProps> = ({ onDismiss }) => {
  const steps: Array<{ icon: React.ReactNode; title: string; detail: string }> = [
    {
      icon: <Mic2 className="w-3.5 h-3.5 text-sky-300 shrink-0" />,
      title: '1 · Pick your input',
      detail:
        'Open the INPUTS panel (left) and choose a live microphone/instrument or the System Audio Bridge. The channels you see now are sample data.',
    },
    {
      icon: <Play className="w-3.5 h-3.5 text-emerald-300 shrink-0" />,
      title: '2 · Start the engine',
      detail:
        'Press START (top right) to run the DSP chain live. MON previews the processed mix on your local speakers or headphones.',
    },
    {
      icon: <Smartphone className="w-3.5 h-3.5 text-teal-300 shrink-0" />,
      title: '3 · Pair the companion',
      detail:
        'Hardware → REMOTE ACCESS shows a QR to pair the HKM FOH phone app for walk-test monitoring from the stage.',
    },
  ];

  return (
    <div
      role="region"
      aria-label="Getting started guide"
      className="shrink-0 border-b border-teal-500/40 bg-gradient-to-r from-[#0B2226] via-[#0C171E] to-[#0B1119] px-4 py-2.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="p-1.5 rounded-md bg-teal-500/15 border border-teal-400/30 text-teal-300 shrink-0 mt-0.5">
            <BookOpen className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="font-mono text-[11px] font-bold tracking-[0.08em] text-teal-200 uppercase">
              Welcome — this console is showing a sample setup
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-5 gap-y-1.5 mt-1.5">
              {steps.map((s) => (
                <div key={s.title} className="flex items-start gap-1.5 min-w-0">
                  {s.icon}
                  <div className="min-w-0">
                    <div className="font-semibold text-[11px] text-slate-100 leading-tight">
                      {s.title}
                    </div>
                    <div className="text-[10px] text-slate-400 leading-snug">{s.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-slate-400">
              <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
              <span>
                Everything you change is saved automatically and restored on the next launch — a
                crash or power cut will not lose your mix.
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss getting started guide"
          title="Dismiss — you can always find help under Help in the menu bar"
          className="shrink-0 p-1 rounded border border-slate-600/70 text-slate-300 hover:text-white hover:border-teal-400/60 hover:bg-teal-500/10 transition cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
