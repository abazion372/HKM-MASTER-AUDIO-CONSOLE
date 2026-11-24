import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SYSTEM_INSTRUCTION = `You are the AI Sound Engineer inside Church Audio Intelligence.
Always ground your answer in the live telemetry, connected hardware capabilities, and DSP state provided in context.
Be concise, practical, and explicit about hardware boundaries (for instance, if a console like the Yamaha MG16XU only sends stereo USB, state that individual mic faders must be adjusted physically on the mixer while master/bus DSP runs in CamillaDSP). Never fabricate measurements not present in the context.`;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      message?: string;
      context?: Record<string, unknown>;
    };
    if (!body.message || typeof body.message !== 'string') {
      return NextResponse.json({ ok: false, error: 'Message text is required.' }, { status: 400 });
    }

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: SYSTEM_INSTRUCTION },
        {
          role: 'user',
          content: `SYSTEM CONTEXT:\n${JSON.stringify(body.context ?? {}, null, 2)}\n\nOPERATOR QUESTION:\n${body.message}`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    return NextResponse.json({ ok: true, reply: completion.choices[0]?.message?.content ?? '' });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'AI assistant error.';
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 });
  }
}
