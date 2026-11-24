import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await ctx.params;
  const profile = audioStore.getDeviceProfile(deviceId);
  return NextResponse.json({ ok: true, profile });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await ctx.params;
  const payload = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const saved = audioStore.saveDeviceProfile(deviceId, payload);
  return NextResponse.json({ ...saved, deviceId });
}
