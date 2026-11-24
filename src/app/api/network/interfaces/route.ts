import { NextRequest, NextResponse } from 'next/server';
import os from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const host = req.headers.get('host') ?? req.headers.get('x-forwarded-host') ?? 'localhost:3000';
  const proto =
    req.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');

  const result: Array<{ name: string; address: string; url: string }> = [
    {
      name: 'Current Console Host',
      address: host,
      url: `${proto}://${host}`,
    },
  ];

  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({
          name,
          address: addr.address,
          url: `${proto}://${host}`,
        });
      }
    }
  }

  return NextResponse.json({ interfaces: result });
}
