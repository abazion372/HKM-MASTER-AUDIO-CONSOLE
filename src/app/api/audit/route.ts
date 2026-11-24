import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const state = audioStore.ensureStore();
  const event = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!event || typeof event !== 'object') {
    return NextResponse.json({ error: 'Invalid audit event payload' }, { status: 400 });
  }
  state.auditEvents = [
    {
      id: `evt-${Date.now()}`,
      timestamp: new Date().toISOString(),
      ...event,
    },
    ...state.auditEvents,
  ].slice(0, 100);
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, auditEvents: state.auditEvents });
}
