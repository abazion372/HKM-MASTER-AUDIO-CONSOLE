import { NextResponse } from 'next/server';
import { scanHostAudioHardware } from '@/lib/hkm-hardware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await scanHostAudioHardware();
  return NextResponse.json({
    ok: true,
    scannedAt: new Date().toISOString(),
    hostPlatform: result.hostPlatform,
    endpoints: result.endpoints,
  });
}
