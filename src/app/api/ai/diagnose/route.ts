import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function buildDiagnosisPrompt(input: {
  telemetry?: Record<string, unknown>;
  device?: Record<string, unknown>;
  dsp?: Record<string, unknown>;
  platform?: string;
  driver?: string;
  question?: string;
}): string {
  const { telemetry, device, dsp, platform, driver, question } = input;
  const t = telemetry ?? {};
  const feedbackRisk = (t.feedbackRisk ?? {}) as Record<string, unknown>;
  const humRisk = (t.humRisk ?? {}) as Record<string, unknown>;
  const mudRisk = (t.mudRisk ?? {}) as Record<string, unknown>;
  const capabilities = (device?.capabilities ?? {}) as Record<string, unknown>;
  const compressor = (dsp?.compressor ?? {}) as Record<string, unknown>;
  const limiter = (dsp?.limiter ?? {}) as Record<string, unknown>;

  return `You are a senior church acoustic & live sound engineer advising a sound operator.
Analyze the REAL measured signal telemetry, hardware capability boundaries, and active DSP configuration below.

HARDWARE PROFILE:
- Device: ${device?.manufacturer ?? 'Unknown'} ${device?.model ?? 'Mixer'} (${device?.tierLabel ?? 'Tier 1'})
- Platform & Driver: ${platform ?? 'windows'} / ${driver ?? 'WASAPI Exclusive'}
- Capabilities: perChannelFaderControl=${Boolean(capabilities.perChannelFaderControl)}, perChannelCapture=${Boolean(capabilities.perChannelCapture)}, stereoMixCapture=${Boolean(capabilities.stereoMixCapture)}
- Limitations: ${capabilities.limitationsNote ?? 'None specified'}

LIVE SIGNAL TELEMETRY:
- Source Mode: ${t.source ?? 'unknown'}
- Pre-DSP RMS / Peak: ${t.preRmsDb ?? -96} dBFS / ${t.prePeakDb ?? -96} dBFS
- Post-DSP RMS / Peak: ${t.postRmsDb ?? -96} dBFS / ${t.postPeakDb ?? -96} dBFS
- Estimated Loudness: ${t.estimatedLufs ?? -70} LUFS
- Feedback Risk: detected=${Boolean(feedbackRisk.detected)}, freq=${feedbackRisk.frequencyHz ?? 'none'} Hz, prominence=${feedbackRisk.prominenceDb ?? 0} dB, persistence=${feedbackRisk.persistenceSec ?? 0}s
- Mains Hum Risk: detected=${Boolean(humRisk.detected)}, fundamental=${humRisk.fundamentalHz ?? 'none'} Hz, 100Hz=${humRisk.harmonic100Db ?? -96} dB, 150Hz=${humRisk.harmonic150Db ?? -96} dB
- Low-Mid Mud Risk: detected=${Boolean(mudRisk.detected)}, center=${mudRisk.centerHz ?? 220} Hz, level=${mudRisk.bandEnergyDb ?? -96} dB

ACTIVE DSP:
- Bypassed: ${Boolean(dsp?.bypassed)}
- HPF: ${dsp?.hpfEnabled ? `${dsp.hpfHz} Hz` : 'Disabled'}
- EQ Bands: ${JSON.stringify(dsp?.eqBands ?? [])}
- Compressor: enabled=${Boolean(compressor.enabled)}, thresh=${compressor.thresholdDb} dB, ratio=${compressor.ratio}:1
- Limiter Ceiling: ${limiter.ceilingDb ?? -1} dBFS

OPERATOR PROMPT: ${question || 'Perform a full evidence-based sound engineering diagnosis of the current signal and hardware state.'}

STRICT ENGINEERING RULES:
1. Never claim you can control physical faders or individual channels if perChannelFaderControl is false (e.g., Yamaha MG16XU stereo USB return).
2. Never blame EQ alone if physical microphone placement, DI ground lift, cable fault, or room reverberation is a primary suspect.
3. Propose at most ONE concrete, safe DSP adjustment (EQ band cut/boost or HPF change) within safe bounds (-12 to +6 dB, 20 to 16000 Hz) if justified by the measured evidence.
4. Explain clearly why and state confidence (0-100).

Respond with ONLY a valid JSON object (no markdown fences, no commentary) using exactly this schema:
{
  "title": string,
  "severity": "nominal" | "advisory" | "warning" | "critical",
  "category": "feedback" | "hum" | "acoustics" | "gain-staging" | "broadcast" | "hardware",
  "confidence": number (0-100),
  "evidence": string,
  "explanation": string,
  "physicalChecks": string[],
  "proposedDspAction": {
    "shouldApply": boolean,
    "description": string,
    "hpfHz": number | null,
    "eqFrequencyHz": number | null,
    "eqGainDb": number | null,
    "eqQ": number | null,
    "eqLabel": string | null
  }
}`;
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const candidates = [withoutFences, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  // Last resort: extract the first {...} block
  const braceMatch = withoutFences.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      telemetry?: Record<string, unknown>;
      device?: Record<string, unknown>;
      dsp?: Record<string, unknown>;
      platform?: string;
      driver?: string;
      question?: string;
    };

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'You are an expert live sound engineer that always responds with strict JSON when a JSON schema is requested. Never add markdown fences or commentary.',
        },
        { role: 'user', content: buildDiagnosisPrompt(body) },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    const parsed = parseJsonLoose(raw);
    if (!parsed) {
      return NextResponse.json(
        { ok: false, error: 'AI diagnostic engine returned an unparseable response.' },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, result: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI diagnostic request failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
