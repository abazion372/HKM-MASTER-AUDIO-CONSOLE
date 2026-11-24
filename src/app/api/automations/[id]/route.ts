import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const state = audioStore.ensureStore();
  const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const existing = Array.isArray(state.automationSnapshots) ? state.automationSnapshots : [];
  state.automationSnapshots = existing.map((s) => (s.id === id ? { ...s, ...patch } : s));
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, automationSnapshots: state.automationSnapshots });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const state = audioStore.ensureStore();
  const existing = Array.isArray(state.automationSnapshots) ? state.automationSnapshots : [];
  state.automationSnapshots = existing.filter((s) => s.id !== id);
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, automationSnapshots: state.automationSnapshots });
}
