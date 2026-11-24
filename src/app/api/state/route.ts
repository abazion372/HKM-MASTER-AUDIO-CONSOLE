import { NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = audioStore.ensureStore();
  return NextResponse.json(state);
}
