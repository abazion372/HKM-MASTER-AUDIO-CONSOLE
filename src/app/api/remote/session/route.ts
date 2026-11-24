import os from 'node:os';
import { NextRequest, NextResponse } from 'next/server';
import { audioStore, type RemoteAccessState } from '@/lib/hkm-store';
import { getWsClients, wsBroadcast } from '@/lib/hkm-relay';

export const dynamic = 'force-dynamic';

function getRequestOrigin(req: NextRequest): { proto: string; host: string } {
  const host = req.headers.get('host') ?? req.headers.get('x-forwarded-host') ?? 'localhost:3000';
  const proto =
    req.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return { proto, host };
}

/**
 * Real LAN addresses of the machine running the console (best practice for
 * phone pairing): every non-internal IPv4 interface, most-likely-used first.
 * Falls back to the request host when the OS reports nothing usable.
 */
function lanInterfaces(req: NextRequest): Array<{ name: string; address: string; url: string }> {
  const { proto, host } = getRequestOrigin(req);
  const out: Array<{ name: string; address: string; url: string }> = [];
  const seen = new Set<string>();
  for (const [ifaceName, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (seen.has(addr.address)) continue;
      seen.add(addr.address);
      out.push({ name: ifaceName, address: addr.address, url: `http://${addr.address}:3000` });
    }
  }
  if (out.length === 0) {
    out.push({ name: 'Current Console Host', address: host, url: `${proto}://${host}` });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const state = audioStore.ensureStore();
  const clients = await getWsClients();
  const interfaces = lanInterfaces(req);
  return NextResponse.json({
    remoteAccess: state.remoteAccess,
    clients,
    interfaces,
  });
}

export async function PATCH(req: NextRequest) {
  const state = audioStore.ensureStore();
  const patch = (await req.json().catch(() => ({}))) as Partial<RemoteAccessState>;
  state.remoteAccess = {
    ...state.remoteAccess,
    ...patch,
    sessionToken: state.remoteAccess.sessionToken,
  };
  // Permission changes must survive a crash immediately — never deduped/delayed.
  audioStore.saveStoreNow(state);
  await wsBroadcast({ type: 'remote:config', remoteAccess: state.remoteAccess });
  return NextResponse.json({ ok: true, remoteAccess: state.remoteAccess });
}
