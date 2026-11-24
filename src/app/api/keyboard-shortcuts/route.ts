import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const state = audioStore.ensureStore();
  const { shortcuts } = (await req.json().catch(() => ({}))) as {
    shortcuts?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(shortcuts)) {
    return NextResponse.json({ error: 'shortcuts must be an array' }, { status: 400 });
  }
  state.keyboardShortcuts = shortcuts;
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, keyboardShortcuts: state.keyboardShortcuts });
}
