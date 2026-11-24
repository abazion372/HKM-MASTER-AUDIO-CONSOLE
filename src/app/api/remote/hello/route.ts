import os from 'node:os';
import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

/**
 * Secret-free console discovery endpoint for the HKM FOH Companion Android
 * app. The APK's pairing screen probes `http://<host>:3000/api/remote/hello`
 * from its own WebView origin, so this route is deliberately CORS-open
 * (Access-Control-Allow-Origin: *) and returns NO pairing token, PIN or
 * client data — just enough to prove "this address is an HKM console" and
 * to brand the connect screen.
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(_req: NextRequest) {
  const state = audioStore.ensureStore();
  // Best-effort LAN hint list (addresses only — no tokens) so the app can
  // suggest the same interface buttons the desktop panel shows.
  const lan: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) lan.push(addr.address);
    }
  }
  return NextResponse.json(
    {
      ok: true,
      app: 'hkm-master-audio-console',
      venueName: state.venue?.venueName ?? 'HKM Console',
      roomName: state.venue?.roomName ?? 'Sanctuary',
      consoleVersion: '1.0.0',
      lanAddresses: lan.slice(0, 4),
    },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    }
  );
}
