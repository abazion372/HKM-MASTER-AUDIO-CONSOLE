import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

/** Stores a custom service preset created from the live mix. */
export async function POST(req: NextRequest) {
  const state = audioStore.ensureStore();
  const preset = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!preset || typeof preset !== 'object' || !preset.id) {
    return NextResponse.json({ error: 'Invalid preset payload' }, { status: 400 });
  }
  const existing = Array.isArray(state.customPresets) ? state.customPresets : [];
  state.customPresets = [preset, ...existing.filter((p) => p.id !== preset.id)].slice(0, 60);
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, customPresets: state.customPresets });
}
