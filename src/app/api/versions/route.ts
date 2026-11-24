import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const state = audioStore.ensureStore();
  const version = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!version || typeof version !== 'object') {
    return NextResponse.json({ error: 'Invalid version payload' }, { status: 400 });
  }
  state.versions = [version, ...state.versions].slice(0, 40);
  state.auditEvents = [
    {
      id: `evt-${Date.now()}`,
      timestamp: new Date().toISOString(),
      actor: String(version.author ?? 'Operator'),
      action: `Saved Configuration ${String(version.version ?? '')}`,
      detail: String(version.summary ?? 'Configuration snapshot stored locally.'),
      authority: 'operator',
    },
    ...state.auditEvents,
  ].slice(0, 100);
  audioStore.saveStore(state);
  return NextResponse.json({ ok: true, versions: state.versions, auditEvents: state.auditEvents });
}
