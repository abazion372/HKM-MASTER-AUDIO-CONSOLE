import { NextRequest, NextResponse } from 'next/server';
import { wsKickClient, wsRefreshClientList, getWsClients } from '@/lib/hkm-relay';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ clientId: string }> }
) {
  const { clientId } = await ctx.params;
  await wsKickClient(clientId);
  await wsRefreshClientList();
  const clients = await getWsClients();
  return NextResponse.json({ ok: true, clients });
}
