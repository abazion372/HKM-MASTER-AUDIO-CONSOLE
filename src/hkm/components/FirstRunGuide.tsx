import React from 'react';
import { X, Mic2, Play, Smartphone, LifeBuoy } from 'lucide-react';
import { openHelpTopic } from './HelpDeskModule.tsx';

interface FirstRunGuideProps {
  onDismiss: () => void;
}

/**
 * One-time orientation strip for fresh installs.
 *
 * Console-style: a single engraved status rail, not an onboarding poster.
 * The three setup steps appear as LED chips (hover for the full step text);
 * the full walkthrough lives in the Help Desk (Quick Start topic). The rail
 * is dismissible and shown exactly once (persisted via `firstRunCompleted`
 * in the state store).
 */
export const FirstRunGuide: React.FC<FirstRunGuideProps> = ({ onDismiss }) => {
  const steps: Array<{ icon: React.ReactNode; chip: string; title: string; detail: string }> = [
    {
      icon: <Mic2 className="w-3 h-3 text-sky-300 shrink-0" />,
      chip: '1 · INPUT',
      title: '1 · Pick your input',
      detail:
        'Open the INPUTS panel (left) and choose a live microphone/instrument or the System Audio Bridge. The channels you see now are sample data.',
    },
    {
      icon: <Play className="w-3 h-3 text-emerald-300 shrink-0" />,
      chip: '2 · ENGINE',
      title: '2 · Start the engine',
      detail:
        'Press START (top right) to run the DSP chain live. MON previews the processed mix on your local speakers or headphones.',
    },
    {
      icon: <Smartphone className="w-3 h-3 text-teal-300 shrink-0" />,
      chip: '3 · PAIR',
      title: '3 · Pair the companion',
      detail:
        'Hardware → REMOTE ACCESS shows a QR to pair the HKM FOH phone app for walk-test monitoring from the stage.',
    },
  ];

  return (
    <div
      role="region"
      aria-label="Getting started guide"
      className="shrink-0 border-b border-teal-500/40 bg-gradient-to-r from-[#0B2226] via-[#0C171E] to-[#0B1119] px-4 py-1.5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-[0.12em] text-teal-200 uppercase shrink-0"
            title="This console boots into a fully-populated sample setup so nothing looks broken on first launch — the data you see is a sample until you assign real inputs"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-teal-300 shadow-[0_0_6px_rgba(45,212,191,0.9)]" />
            SAMPLE SETUP
          </span>
          {steps.map((s) => (
            <button
              key={s.chip}
              type="button"
              onClick={() => openHelpTopic('quick-start')}
              title={`${s.title} — ${s.detail}`}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#2A3646] bg-[#0A0F16] font-mono text-[9px] font-bold tracking-wider text-slate-300 hover:text-teal-200 hover:border-teal-400/50 transition cursor-pointer shrink-0"
            >
              {s.icon}
              {s.chip}
            </button>
          ))}
          <span
            className="hidden md:flex items-center gap-1.5 font-mono text-[9px] text-slate-500 shrink-0"
            title="Everything you change is saved automatically and restored on the next launch — a crash or power cut will not lose your mix."
          >
            <span className="hw-lamp" data-on="green" style={{ width: 6, height: 6 }} aria-hidden="true" />
            AUTOSAVE
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => openHelpTopic('quick-start')}
            title="Help Desk — Quick Start (also under Help in the menu bar)"
            aria-label="Open the Help Desk — Quick Start"
            className="flex items-center justify-center p-1 rounded border border-teal-500/40 bg-teal-500/10 text-teal-200 hover:bg-teal-500/20 transition cursor-pointer"
          >
            <LifeBuoy className="w-3 h-3" />
          </button>
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
    </div>
  );
};
