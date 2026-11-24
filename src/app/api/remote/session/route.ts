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

export async function GET(req: NextRequest) {
  const state = audioStore.ensureStore();
  const clients = await getWsClients();
  const { proto, host } = getRequestOrigin(req);
  return NextResponse.json({
    remoteAccess: state.remoteAccess,
    clients,
    interfaces: [
      {
        name: 'Current Console Host',
        address: host,
        url: `${proto}://${host}`,
      },
    ],
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
  audioStore.saveStore(state);
  await wsBroadcast({ type: 'remote:config', remoteAccess: state.remoteAccess });
  return NextResponse.json({ ok: true, remoteAccess: state.remoteAccess });
}
