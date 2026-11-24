import { NextResponse } from 'next/server';
import { audioStore, generateToken } from '@/lib/hkm-store';
import { wsKickAllMobile, wsRefreshClientList } from '@/lib/hkm-relay';

export const dynamic = 'force-dynamic';

export async function POST() {
  const state = audioStore.ensureStore();
  state.remoteAccess = {
    ...state.remoteAccess,
    sessionToken: generateToken(),
    createdAt: new Date().toISOString(),
  };
  state.auditEvents = [
    {
      id: `evt-${Date.now()}`,
      timestamp: new Date().toISOString(),
      actor: 'Sound Engineer',
      action: 'Rotated Remote Access QR Token',
      detail: 'Previous mobile companion sessions revoked; new pairing token issued.',
      authority: 'operator',
    },
    ...state.auditEvents,
  ].slice(0, 100);
  audioStore.saveStore(state);
  await wsKickAllMobile();
  await wsRefreshClientList();
  return NextResponse.json({ ok: true, remoteAccess: state.remoteAccess });
}
