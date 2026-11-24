import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const state = audioStore.ensureStore();
  const { mappings } = (await req.json().catch(() => ({}))) as {
    mappings?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(mappings)) {
    return NextResponse.json({ error: 'mappings must be an array' }, { status: 400 });
  }
  state.midiMappings = mappings;
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, midiMappings: state.midiMappings });
}
