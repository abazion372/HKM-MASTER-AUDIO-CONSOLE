import { NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = audioStore.ensureStore();
  // One-shot corrupt-recovery relay: when the JSON store had to be reseeded,
  // the operator is told (with a pointer to the preserved .bak) instead of
  // silently losing their mix.
  const recoveredFromCorrupt = audioStore.consumeCorruptFlag();
  return NextResponse.json({ ...state, recoveredFromCorrupt });
}
