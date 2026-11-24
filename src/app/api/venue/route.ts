import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const state = audioStore.ensureStore();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  state.venue = {
    ...state.venue,
    ...body,
  } as typeof state.venue;
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, venue: state.venue });
}
