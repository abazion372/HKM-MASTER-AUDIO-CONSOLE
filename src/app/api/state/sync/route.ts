import { NextRequest, NextResponse } from 'next/server';
import { audioStore, type PersistedState } from '@/lib/hkm-store';
import { wsBroadcast } from '@/lib/hkm-relay';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const state = audioStore.ensureStore();
  const body = (await req.json().catch(() => ({}))) as Partial<PersistedState>;

  if (body.venue && typeof body.venue === 'object') {
    state.venue = { ...state.venue, ...body.venue };
  }
  if (Array.isArray(body.channels)) state.channels = body.channels;
  if (body.dsp && typeof body.dsp === 'object') state.dsp = body.dsp;
  if (typeof body.activePresetId === 'string') state.activePresetId = body.activePresetId;
  if (body.broadcastDsp && typeof body.broadcastDsp === 'object') {
    state.broadcastDsp = body.broadcastDsp;
  }
  if (Array.isArray(body.zones)) state.zones = body.zones;
  if (body.obsStatus && typeof body.obsStatus === 'object') state.obsStatus = body.obsStatus;
  if (body.measurement && typeof body.measurement === 'object') {
    state.measurement = body.measurement;
  }
  if (body.bassDi && typeof body.bassDi === 'object') state.bassDi = body.bassDi;
  if (typeof body.emergencyMuted === 'boolean') state.emergencyMuted = body.emergencyMuted;
  if (Array.isArray(body.findings)) state.findings = body.findings;

  audioStore.saveStore(state);
  await wsBroadcast({
    type: 'state:sync',
    channels: state.channels,
    dsp: state.dsp,
    venue: state.venue,
    emergencyMuted: state.emergencyMuted,
    zones: state.zones,
  });
  return NextResponse.json({ ok: true });
}
