import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = audioStore.ensureStore();
  return NextResponse.json({ ok: true, automationSnapshots: state.automationSnapshots ?? [] });
}

export async function POST(req: NextRequest) {
  const state = audioStore.ensureStore();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const snapshot = (body?.snapshot ?? body) as Record<string, unknown> | null;
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.id) {
    return NextResponse.json({ error: 'Invalid automation snapshot payload' }, { status: 400 });
  }
  const existing = Array.isArray(state.automationSnapshots) ? state.automationSnapshots : [];
  state.automationSnapshots = [
    snapshot,
    ...existing.filter((s) => s.id !== snapshot.id),
  ].slice(0, 40);
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, automationSnapshots: state.automationSnapshots });
}
