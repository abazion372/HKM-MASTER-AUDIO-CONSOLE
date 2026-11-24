/**
 * HKM Audio System — WebSocket mini-service (port 3030)
 *
 * Implements the FOH remote-companion realtime protocol:
 *   - Desktop consoles connect to  /ws?role=desktop
 *   - Mobile companions connect to /ws?role=mobile&token=<pairing token>
 *
 * Shared state lives in the same JSON store used by the Next.js API layer
 * (db/hkm-state.json), so both processes always operate on one source of truth.
 *
 * Internal endpoints (localhost-only, used by the Next.js server):
 *   POST /internal/broadcast            { payload }
 *   POST /internal/broadcast-client-list
 *   POST /internal/kick-mobile
 *   POST /internal/kick-client          { clientId }
 *   GET  /internal/clients
 */

import path from 'node:path';

const PORT = 3030;
const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..');
process.env.HKM_DATA_DIR ??= path.join(PROJECT_ROOT, 'db');

type ClientRole = 'desktop' | 'mobile';

interface ClientRecord {
  clientId: string;
  ws: import('bun').ServerWebSocket<WsSocketData>;
  role: ClientRole;
  deviceName: string;
  ip: string;
  connectedAt: string;
  lastSeenAt: string;
  pinVerified: boolean;
}

interface WsSocketData {
  role: ClientRole;
  token: string;
  deviceName: string;
  ip: string;
  clientId: string;
}

// Imported after HKM_DATA_DIR is set so the store resolves the shared file.
const { audioStore } = await import('../../src/lib/hkm-store.ts');

const clients = new Map<string, ClientRecord>();

function getPublicClientList() {
  return Array.from(clients.values())
    .filter((c) => c.role === 'mobile')
    .map(({ clientId, role, deviceName, ip, connectedAt, lastSeenAt }) => ({
      clientId,
      role,
      deviceName,
      ip,
      connectedAt,
      lastSeenAt,
    }));
}

function safeSend(ws: import('bun').ServerWebSocket<WsSocketData>, text: string): void {
  try {
    ws.send(text);
  } catch {
    // socket already closing
  }
}

function broadcast(payload: Record<string, unknown>, excludeClientId?: string): void {
  const serialized = JSON.stringify(payload);
  for (const [id, client] of clients.entries()) {
    if (excludeClientId && id === excludeClientId) continue;
    if (client.role === 'mobile' && !client.pinVerified) continue;
    safeSend(client.ws, serialized);
  }
}

function broadcastClientList(): void {
  const list = getPublicClientList();
  const msg = JSON.stringify({ type: 'remote:clients', clients: list });
  for (const client of clients.values()) {
    if (client.role === 'desktop') {
      safeSend(client.ws, msg);
    }
  }
}

function isLoopbackRequest(req: import('bun').BunRequest): boolean {
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return true; // direct localhost call (server-to-server)
  return xff
    .split(',')
    .every((ip) => /^127\.|^::1$|^localhost$/i.test(ip.trim()));
}

let clientIdCounter = 0;

const server = Bun.serve<WsSocketData>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      const role: ClientRole = url.searchParams.get('role') === 'mobile' ? 'mobile' : 'desktop';
      const token = url.searchParams.get('token') || '';
      const deviceName =
        url.searchParams.get('device') ||
        (role === 'mobile' ? 'FOH Mobile Companion' : 'FOH Desktop Console');
      const ip =
        (req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || 'local';

      const clientId = `cli-${Date.now().toString(36)}-${(clientIdCounter++).toString(36)}`;
      const upgraded = srv.upgrade(req, {
        data: { role, token, deviceName, ip, clientId },
      });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    if (url.pathname.startsWith('/internal/')) {
      if (!isLoopbackRequest(req)) {
        return Response.json({ ok: false, error: 'Internal endpoints are local-only.' }, { status: 403 });
      }

      const action = url.pathname.replace('/internal/', '');

      if (req.method === 'GET' && action === 'clients') {
        return Response.json({ clients: getPublicClientList() });
      }

      if (req.method === 'GET' && action === 'stats') {
        let desktop = 0;
        let mobile = 0;
        for (const client of clients.values()) {
          if (client.role === 'desktop') desktop += 1;
          else mobile += 1;
        }
        return Response.json({ total: clients.size, desktop, mobile });
      }

      if (req.method !== 'POST') {
        return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
      }

      const body = (req.json().catch(() => ({}))) as Record<string, unknown>;

      switch (action) {
        case 'broadcast': {
          const payload = body.payload;
          if (payload && typeof payload === 'object') {
            broadcast(payload as Record<string, unknown>);
          }
          return Response.json({ ok: true, recipients: clients.size });
        }
        case 'broadcast-client-list': {
          broadcastClientList();
          return Response.json({ ok: true, recipients: clients.size });
        }
        case 'kick-mobile': {
          for (const [id, client] of clients.entries()) {
            if (client.role === 'mobile') {
              try {
                client.ws.close(4002, 'Pairing token rotated by FOH engineer');
              } catch {
                // already closed
              }
              clients.delete(id);
            }
          }
          return Response.json({ ok: true });
        }
        case 'kick-client': {
          const clientId = String(body.clientId ?? '');
          const target = clients.get(clientId);
          if (target) {
            try {
              target.ws.close(4003, 'Session revoked by FOH console');
            } catch {
              // already closed
            }
            clients.delete(clientId);
            broadcastClientList();
          }
          return Response.json({ ok: true, clients: getPublicClientList() });
        }
        default:
          return Response.json({ ok: false, error: 'Unknown internal action.' }, { status: 404 });
      }
    }

    return new Response('HKM Audio WebSocket service. Connect via /ws', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },

  websocket: {
    open(ws) {
      const data = ws.data;
      const state = audioStore.ensureStore();
      const nowIso = new Date().toISOString();

      if (data.role === 'mobile' && data.token !== state.remoteAccess.sessionToken) {
        safeSend(ws, JSON.stringify({ type: 'auth:error', error: 'Invalid or expired pairing token.' }));
        try {
          ws.close(4001, 'Invalid pairing token');
        } catch {
          // ignore
        }
        return;
      }

      const record: ClientRecord = {
        clientId: data.clientId,
        ws,
        role: data.role,
        deviceName: data.deviceName,
        ip: data.ip,
        connectedAt: nowIso,
        lastSeenAt: nowIso,
        pinVerified: data.role === 'desktop' || !state.remoteAccess.pinEnabled,
      };
      clients.set(data.clientId, record);

      if (record.pinVerified) {
        safeSend(
          ws,
          JSON.stringify({
            type: 'state:full',
            state: audioStore.ensureStore(),
            clientId: data.clientId,
          })
        );
      } else {
        safeSend(ws, JSON.stringify({ type: 'auth:pin-required', clientId: data.clientId }));
      }

      if (data.role === 'mobile') {
        const fresh = audioStore.ensureStore();
        fresh.auditEvents = [
          {
            id: `evt-${Date.now()}`,
            timestamp: nowIso,
            actor: data.deviceName,
            action: 'Mobile Companion Linked',
            detail: `Remote FOH companion connected from ${data.ip}`,
            authority: 'system',
          },
          ...fresh.auditEvents,
        ].slice(0, 100);
        audioStore.saveStore(fresh);
        broadcastClientList();
      }
    },

    message(ws, message) {
      const record = clients.get(ws.data.clientId);
      if (!record) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(message)) as Record<string, unknown>;
      } catch {
        return;
      }

      record.lastSeenAt = new Date().toISOString();
      const current = audioStore.ensureStore();

      if (msg.type === 'auth:verify-pin') {
        if (String(msg.pin ?? '') === current.remoteAccess.pinCode) {
          record.pinVerified = true;
          safeSend(ws, JSON.stringify({ type: 'auth:ok' }));
          safeSend(
            ws,
            JSON.stringify({ type: 'state:full', state: audioStore.ensureStore(), clientId: record.clientId })
          );
          broadcastClientList();
        } else {
          safeSend(ws, JSON.stringify({ type: 'auth:error', error: 'Incorrect PIN code.' }));
        }
        return;
      }

      if (!record.pinVerified) {
        safeSend(ws, JSON.stringify({ type: 'auth:pin-required' }));
        return;
      }

      if (msg.type === 'channel:patch') {
        const channelId = String(msg.channelId ?? '');
        const rawPatch = (msg.patch && typeof msg.patch === 'object' ? msg.patch : {}) as Record<
          string,
          unknown
        >;
        if (!channelId) return;

        // Enforce remote companion permissions
        const sanitizedPatch: Record<string, unknown> = { ...rawPatch };
        if (record.role === 'mobile') {
          if (!current.remoteAccess.allowGainAdjustment) {
            delete sanitizedPatch.gainDb;
            delete sanitizedPatch.phantom48v;
            delete sanitizedPatch.padDb;
          }
          if (!current.remoteAccess.allowMuteControl) {
            delete sanitizedPatch.mute;
            delete sanitizedPatch.solo;
          }
        }
        if (Object.keys(sanitizedPatch).length === 0) return;

        audioStore.patchChannel(channelId, sanitizedPatch);
        broadcast(
          {
            type: 'channel:patch',
            channelId,
            patch: sanitizedPatch,
            sourceRole: record.role,
          },
          record.clientId
        );
        return;
      }

      if (msg.type === 'master:patch') {
        if (record.role === 'mobile' && !current.remoteAccess.allowMasterTrim) {
          return;
        }
        const updatedMaster = audioStore.patchMaster({
          inputTrimDb: typeof msg.inputTrimDb === 'number' ? msg.inputTrimDb : undefined,
          emergencyMuted:
            typeof msg.emergencyMuted === 'boolean' ? msg.emergencyMuted : undefined,
        });
        broadcast(
          {
            type: 'master:patch',
            inputTrimDb: (updatedMaster.dsp as { inputTrimDb?: number }).inputTrimDb,
            emergencyMuted: updatedMaster.emergencyMuted,
            sourceRole: record.role,
          },
          record.clientId
        );
        return;
      }

      if (msg.type === 'telemetry:frame' && record.role === 'desktop') {
        const serialized = JSON.stringify({
          type: 'telemetry:frame',
          telemetry: msg.telemetry,
        });
        for (const client of clients.values()) {
          if (client.role === 'mobile' && client.pinVerified) {
            safeSend(client.ws, serialized);
          }
        }
      }
    },

    close(ws) {
      const record = clients.get(ws.data.clientId);
      if (!record) return;
      clients.delete(record.clientId);
      if (record.role === 'mobile') {
        broadcastClientList();
      }
    },
  },
});

console.log(`[hkm-audio-ws] WebSocket service listening on ws://127.0.0.1:${server.port}/ws`);
console.log(`[hkm-audio-ws] Shared state file: ${path.join(process.env.HKM_DATA_DIR ?? '', 'hkm-state.json')}`);
