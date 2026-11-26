import { NextRequest, NextResponse } from 'next/server';
import { audioStore, CURRENT_SCHEMA_VERSION, type PersistedState } from '@/lib/hkm-store';
import { wsBroadcast } from '@/lib/hkm-relay';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  // A malformed body must be a visible failure, not a fake success: the old
  // behaviour coerced garbage JSON to {} and still answered {ok:true}, which
  // made the client's dedup think the state was safely on disk.
  let body: Partial<PersistedState>;
  try {
    body = (await req.json()) as Partial<PersistedState>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: 'Body must be a JSON object' }, { status: 400 });
  }

  const state = audioStore.ensureStore();

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
  if (typeof body.firstRunCompleted === 'boolean') {
    state.firstRunCompleted = body.firstRunCompleted;
  }
  state.schemaVersion = CURRENT_SCHEMA_VERSION;

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
