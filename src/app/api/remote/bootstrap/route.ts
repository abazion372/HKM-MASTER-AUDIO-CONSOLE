import { NextRequest, NextResponse } from 'next/server';
import { audioStore } from '@/lib/hkm-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const state = audioStore.ensureStore();
  if (!token || token !== state.remoteAccess.sessionToken) {
    return NextResponse.json(
      { ok: false, error: 'Invalid or expired QR pairing token.' },
      { status: 401 }
    );
  }
  return NextResponse.json({
    ok: true,
    pinRequired: state.remoteAccess.pinEnabled,
    remoteAccess: {
      pinEnabled: state.remoteAccess.pinEnabled,
      allowGainAdjustment: state.remoteAccess.allowGainAdjustment,
      allowMuteControl: state.remoteAccess.allowMuteControl,
      allowMasterTrim: state.remoteAccess.allowMasterTrim,
    },
    state: state.remoteAccess.pinEnabled
      ? null
      : {
          venue: state.venue,
          channels: state.channels,
          dsp: state.dsp,
          emergencyMuted: state.emergencyMuted,
        },
  });
}
