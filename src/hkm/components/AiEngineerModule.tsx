import React, { useState } from 'react';
import { Sparkles, Send, CheckCircle2, AlertTriangle, ShieldCheck, X } from 'lucide-react';
import type {
  DiagnosticFinding,
  DriverBackend,
  DspConfig,
  HardwareDevice,
  PlatformTarget,
  SignalTelemetry,
} from '../types/audio.ts';
import { appFetch } from '../utils/appApi.ts';
import { ArcGauge, SegmentedLedMeter } from './StudioControls.tsx';

interface AiEngineerModuleProps {
  device: HardwareDevice;
  platform: PlatformTarget;
  driver: DriverBackend;
  dsp: DspConfig;
  telemetry: SignalTelemetry;
  findings: DiagnosticFinding[];
  onAddFinding: (finding: DiagnosticFinding) => void;
  onApproveFinding: (id: string) => void;
  onDismissFinding: (id: string) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

const QUICK_QUESTIONS = [
  "Why is the preacher's microphone unclear?",
  'Why is the bass guitar humming?',
  'Why does the back of the church sound quiet?',
  'How can I improve the choir without feedback?',
];

// Silkscreen keys for the quick questions — the full questions ride on
// button tooltips / aria-labels and are sent unchanged to the AI chat.
const QUICK_QUESTION_KEYS = ['MIC CLARITY', 'BASS HUM', 'REAR LEVEL', 'CHOIR FB'];

export const AiEngineerModule: React.FC<AiEngineerModuleProps> = ({
  device,
  platform,
  driver,
  dsp,
  telemetry,
  findings,
  onAddFinding,
  onApproveFinding,
  onDismissFinding,
}) => {
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const headroomDb = telemetry.isRunning ? Math.max(0, -telemetry.postPeakDb) : 0;

  const handleRunAiDiagnosis = async () => {
    setDiagnosing(true);
    setDiagError(null);
    try {
      const resp = await appFetch('/api/ai/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telemetry,
          device,
          dsp,
          platform,
          driver,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setDiagError(data.error || 'AI DIAG ERROR');
        return;
      }
      const r = data.result;
      const newFinding: DiagnosticFinding = {
        id: `ai-${Date.now()}`,
        timestamp: new Date().toISOString(),
        severity: r.severity || 'advisory',
        category: r.category || 'acoustics',
        title: r.title || 'AI Engineering Analysis',
        evidence: r.evidence || 'Measured live spectrum and hardware capability matrix',
        confidence: typeof r.confidence === 'number' ? r.confidence : 80,
        explanation: r.explanation || '',
        physicalChecks: Array.isArray(r.physicalChecks) ? r.physicalChecks : [],
        proposedPatch: r.proposedDspAction?.shouldApply
          ? {
              description: r.proposedDspAction.description || 'Apply recommended EQ/HPF adjustment',
              hpfHz: r.proposedDspAction.hpfHz,
              hpfEnabled: typeof r.proposedDspAction.hpfHz === 'number' ? true : undefined,
              eqBandUpdate:
                typeof r.proposedDspAction.eqFrequencyHz === 'number'
                  ? {
                      index: 1,
                      enabled: true,
                      label: r.proposedDspAction.eqLabel || 'AI Correction',
                      frequency: r.proposedDspAction.eqFrequencyHz,
                      gainDb: r.proposedDspAction.eqGainDb ?? -3,
                      q: r.proposedDspAction.eqQ ?? 2.0,
                    }
                  : undefined,
            }
          : undefined,
        status: 'pending',
        beforeSnapshot: telemetry.isRunning
          ? { rmsDb: telemetry.postRmsDb, peakDb: telemetry.postPeakDb }
          : undefined,
      };
      onAddFinding(newFinding);
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'NETWORK ERROR');
    } finally {
      setDiagnosing(false);
    }
  };

  const handleSendChat = async (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed) return;
    setChatError(null);
    setMessages((prev) => [...prev, { role: 'user', text: trimmed }]);
    setChatInput('');
    setChatBusy(true);

    try {
      const resp = await appFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          context: {
            device: `${device.manufacturer} ${device.model}`,
            capabilities: device.capabilities,
            platform,
            driver,
            telemetry,
            dspSummary: {
              bypassed: dsp.bypassed,
              hpfHz: dsp.hpfEnabled ? dsp.hpfHz : null,
              eqBands: dsp.eqBands,
              compressor: dsp.compressor,
            },
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setChatError(data.error || 'AI CHAT ERROR');
        return;
      }
      setMessages((prev) => [...prev, { role: 'assistant', text: data.reply }]);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'NETWORK ERROR');
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Studio Rack Header */}
      <div className="rounded-lg border border-slate-800 bg-gradient-to-b from-[#161D29] to-[#0E131C] p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-8 rounded-xs bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.6)]" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-bold text-sky-400">11</span>
              <h1 className="font-display text-lg font-semibold text-white tracking-tight">
                AI SOUND ENGINEER (EVIDENCE-BASED CLOSED LOOP)
              </h1>
            </div>
            <p
              className="text-[9.5px] font-mono font-bold uppercase hw-engraved"
              title="Observe → Diagnose → Propose → Engineer Approves (human-in-the-loop safety gate)"
            >
              OBSERVE → DIAGNOSE → PROPOSE → APPROVE
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleRunAiDiagnosis}
          disabled={diagnosing}
          className="px-4 py-2 rounded hw-key !bg-none !bg-sky-600 hover:!bg-sky-500 !border-sky-400/50 disabled:opacity-50 !text-white text-xs font-mono font-semibold flex items-center gap-2 transition-colors self-start md:self-auto cursor-pointer"
          title="Run AI diagnosis over live telemetry — findings queue for human approval"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{diagnosing ? 'ANALYZING TELEMETRY...' : 'RUN AI DIAGNOSIS'}</span>
        </button>
      </div>

      {/* Live Evidence Telemetry Strip */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-center rounded-lg border border-slate-800 bg-[#0D1119] p-3.5">
        <div className="xl:col-span-5 grid grid-cols-3 gap-2.5 items-center">
          <ArcGauge
            label="Feedback Risk"
            value={telemetry.feedbackRisk.detected ? telemetry.feedbackRisk.confidence : 0}
            max={100}
            displayValue={`${telemetry.feedbackRisk.detected ? telemetry.feedbackRisk.confidence : 0}%`}
            sublabel={telemetry.feedbackRisk.frequencyHz ? `${telemetry.feedbackRisk.frequencyHz} Hz` : 'Clean'}
            tone={telemetry.feedbackRisk.detected ? 'red' : 'emerald'}
          />
          <ArcGauge
            label="Peak Headroom"
            value={headroomDb}
            max={24}
            displayValue={telemetry.isRunning ? `${headroomDb.toFixed(1)}dB` : '--'}
            sublabel={telemetry.isRunning ? `${telemetry.clippingEvents} Clips` : 'Standby'}
            tone={!telemetry.isRunning ? 'sky' : headroomDb < 4 ? 'red' : 'sky'}
          />
          <div className="flex items-center justify-around py-2 bg-[#070A10] border border-slate-800 rounded">
            <div className="flex flex-col items-center gap-1">
              <SegmentedLedMeter
                levelDb={telemetry.isRunning ? telemetry.preRmsDb : -96}
                peakDb={telemetry.isRunning ? telemetry.prePeakDb : -96}
                height={76}
                segments={12}
              />
              <span className="font-mono text-[9px] text-slate-400">PRE</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <SegmentedLedMeter
                levelDb={telemetry.isRunning ? telemetry.postRmsDb : -96}
                peakDb={telemetry.isRunning ? telemetry.postPeakDb : -96}
                height={76}
                segments={12}
              />
              <span className="font-mono text-[9px] text-sky-400">POST</span>
            </div>
          </div>
        </div>

        <div className="xl:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
          <div className="p-2.5 rounded bg-[#070A10] border border-slate-800">
            <div className="text-[10px] text-slate-500">HARDWARE</div>
            <div className="text-slate-100 truncate mt-0.5">{device.model}</div>
          </div>
          <div className="p-2.5 rounded bg-[#070A10] border border-slate-800">
            <div className="text-[10px] text-slate-500">AUTHORITY</div>
            <div className="text-sky-400 mt-0.5">
              {device.capabilities.perChannelFaderControl ? 'FULL DIGITAL' : 'STEREO USB'}
            </div>
          </div>
          <div className="p-2.5 rounded bg-[#070A10] border border-slate-800">
            <div className="text-[10px] text-slate-500">50/60 Hz HUM</div>
            <div className={telemetry.humRisk.detected ? 'text-amber-400 mt-0.5' : 'text-emerald-400 mt-0.5'}>
              {telemetry.humRisk.detected ? 'HARMONIC HUM' : 'CLEAR'}
            </div>
          </div>
          <div className="p-2.5 rounded bg-[#070A10] border border-slate-800">
            <div className="text-[10px] text-slate-500">SAFETY GATE</div>
            <div className="text-emerald-400 mt-0.5">HUMAN APPROVAL</div>
          </div>
        </div>
      </div>

      {/* Authority boundary — engraved LED chips, details in Help Desk */}
      <div className="rounded-lg border border-slate-800 bg-[#0D1119] px-3 py-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[9.5px] font-bold tracking-wider">
        <span className="flex items-center gap-1.5"
          title={`HW AUTHORITY (${device.model}) — ${device.capabilities.perChannelFaderControl ? 'Remote preamp & fader control active' : 'Manual physical knobs/faders required — software can only advise'}`}>
          <span
            aria-hidden="true"
            className="hw-lamp"
            style={{ width: 5, height: 5 }}
            data-on={device.capabilities.perChannelFaderControl ? 'green' : 'amber'}
          />
          <span className="text-slate-500">HW AUTH</span>
          <span className={device.capabilities.perChannelFaderControl ? 'text-emerald-400' : 'text-amber-400'}>
            {device.capabilities.perChannelFaderControl ? 'REMOTE PRE/FADERS' : 'PHYSICAL KNOBS'}
          </span>
        </span>
        <span className="flex items-center gap-1.5"
          title="SW DSP AUTHORITY — full CamillaDSP reach: PEQ, HPF, dynamics, limiter & stream bus">
          <span
            aria-hidden="true"
            className="hw-lamp"
            style={{ width: 5, height: 5 }}
            data-on="cyan"
          />
          <span className="text-slate-500">SW AUTH</span>
          <span className="text-sky-400">FULL DSP · PEQ · DYN · LIM · STREAM</span>
        </span>
      </div>

      {diagError && (
        <div className="p-3 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300">
          {diagError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Diagnostic Approval Queue */}
        <div className="lg:col-span-7 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 space-y-3">
          <div className="font-mono text-xs font-semibold uppercase border-b border-slate-800 pb-2 hw-engraved">
            Diagnostic Findings · Approval Queue ({findings.length})
          </div>

          {findings.length === 0 ? (
            <div className="py-10 flex flex-col items-center justify-center gap-2.5 text-center">
              <span aria-hidden="true" className="hw-lamp" style={{ width: 6, height: 6 }} />
              <span
                className="font-mono text-[10px] font-bold tracking-wider text-slate-500"
                title="Start the audio engine or run an AI diagnosis — findings queue here for human approval"
              >
                QUEUE EMPTY — RUN AI DIAGNOSIS
              </span>
              <span
                className="font-mono text-[8.5px] font-bold tracking-wider text-slate-600"
                title="Approvals stay in engineer hands — the AI proposes, the engineer approves"
              >
                HUMAN APPROVAL ONLY
              </span>
            </div>
          ) : (
            <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
              {findings.map((f) => (
                <div
                  key={f.id}
                  className="p-3.5 rounded border border-slate-800 bg-[#090D14] space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 text-xs font-semibold text-white">
                        {f.status === 'verified' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                        )}
                        <span>{f.title}</span>
                      </div>
                      <div className="font-mono text-[11px] text-slate-400">
                        {f.category} · CONFIDENCE {f.confidence}% · {f.evidence}
                      </div>
                    </div>
                    {f.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => onDismissFinding(f.id)}
                        aria-label="Dismiss finding"
                        className="text-slate-500 hover:text-slate-200"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">{f.explanation}</p>

                  {f.physicalChecks.length > 0 && (
                    <div className="text-[11px] text-slate-400 space-y-1">
                      <div className="font-mono text-[10px] text-sky-400 uppercase">
                        Physical &amp; Acoustic Checks
                      </div>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {f.physicalChecks.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {f.proposedPatch && f.status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => onApproveFinding(f.id)}
                      title={`Approve & apply patch: ${f.proposedPatch.description}`}
                      className="w-full py-2 px-3 rounded hw-key !bg-none !bg-sky-600 hover:!bg-sky-500 !border-sky-400/60 !text-white text-xs font-mono font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>APPROVE &amp; APPLY</span>
                    </button>
                  )}

                  {f.status === 'verified' && (
                    <div className="text-[11px] font-mono text-emerald-400 flex items-center justify-between pt-1 border-t border-slate-800">
                      <span
                        className="flex items-center gap-1.5"
                        title="Approved and applied to the CamillaDSP processing chain"
                      >
                        <span
                          aria-hidden="true"
                          className="hw-lamp"
                          style={{ width: 5, height: 5 }}
                          data-on="green"
                        />
                        APPROVED · APPLIED
                      </span>
                      {f.beforeSnapshot && f.afterSnapshot && (
                        <span>
                          {f.beforeSnapshot.rmsDb.toFixed(1)} → {f.afterSnapshot.rmsDb.toFixed(1)} dBFS
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Conversational Sound Engineer Terminal */}
        <div className="lg:col-span-5 rounded-lg border border-slate-800 bg-[#0D1119] p-3.5 flex flex-col justify-between gap-3 h-[520px]">
          <div className="space-y-2">
            <div className="font-mono text-xs font-semibold uppercase border-b border-slate-800 pb-2 hw-engraved">
              AI Engineer Console Terminal
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_QUESTIONS.map((q, i) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => handleSendChat(q)}
                  disabled={chatBusy}
                  title={q}
                  aria-label={q}
                  className="text-[10px] font-bold tracking-wider px-2.5 py-1 rounded hw-key hover:!border-sky-400/60 transition-colors disabled:opacity-40 cursor-pointer"
                >
                  {QUICK_QUESTION_KEYS[i]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 py-2 border-y border-slate-800">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-center px-4">
                <span
                  className="font-mono text-[10px] font-bold tracking-wider text-slate-500"
                  title={`Answers cite ${device.model} capabilities and live FFT telemetry`}
                >
                  ASK — CITES {device.model.toUpperCase()} + LIVE FFT
                </span>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={`p-2.5 rounded text-xs leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-sky-500/15 border border-sky-500/30 text-slate-100 ml-6'
                      : 'bg-[#070A10] border border-slate-800 text-slate-200 mr-4 whitespace-pre-wrap'
                  }`}
                >
                  <div className="font-mono text-[10px] text-sky-400 mb-1 uppercase">
                    {m.role === 'user' ? 'Engineer' : 'AI Sound Engineer'}
                  </div>
                  {m.text}
                </div>
              ))
            )}
            {chatBusy && (
              <div className="text-xs font-mono text-sky-400 px-2">ANALYZING TELEMETRY...</div>
            )}
            {chatError && (
              <div className="text-xs text-red-400 px-2">{chatError}</div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendChat(chatInput);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="FEEDBACK · HUM · GAIN · ZONES"
              aria-label="Ask the AI sound engineer about feedback, hum, gain staging, or zones"
              className="flex-1 px-3 py-2 rounded border border-slate-700 bg-[#070A10] text-slate-100 text-xs font-mono"
            />
            <button
              type="submit"
              disabled={chatBusy || !chatInput.trim()}
              title="Send question to the AI Sound Engineer"
              className="px-3 py-2 rounded hw-key !bg-none !bg-sky-600 hover:!bg-sky-500 !border-sky-400/60 !text-white disabled:opacity-40 text-xs font-medium flex items-center gap-1 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
