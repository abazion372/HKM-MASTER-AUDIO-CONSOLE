import { NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';
import { getWsStats } from '@/lib/hkm-relay';

export const dynamic = 'force-dynamic';

export async function GET() {
  const dbStats = audioStore.getStats();
  const ws = await getWsStats();
  return NextResponse.json({
    status: 'ok',
    engine: 'HKM Audio System — Church Audio Intelligence Control Plane',
    aiConfigured: true,
    storage: dbStats.engine,
    dbStats,
    wsClients: ws.total,
    wsDesktopClients: ws.desktop,
    wsMobileClients: ws.mobile,
  });
}
