/**
 * Server-side relay between the Next.js API layer and the audio-ws
 * mini-service (Bun WebSocket server on port 3030).
 *
 * These calls are internal (server-to-server on localhost) and never
 * originate from the browser, so direct localhost URLs are safe here.
 */

const WS_SERVICE_ORIGIN = process.env.HKM_WS_SERVICE ?? 'http://127.0.0.1:3030';

export interface RemoteClientPublicInfo {
  clientId: string;
  role: 'desktop' | 'mobile';
  deviceName: string;
  ip: string;
  connectedAt: string;
  lastSeenAt: string;
}

async function relay(
  action: string,
  init?: { method?: string; body?: unknown }
): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${WS_SERVICE_ORIGIN}/internal/${action}`, {
      method: init?.method ?? 'POST',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeout);
    return res;
  } catch {
    // WS mini-service offline — console still works, remote sync is unavailable.
    return null;
  }
}

/** Broadcast an arbitrary payload to eligible websocket clients. */
export async function wsBroadcast(payload: Record<string, unknown>): Promise<void> {
  await relay('broadcast', { body: { payload } });
}

/** Ask the ws service to re-publish the connected mobile client list to desktops. */
export async function wsRefreshClientList(): Promise<void> {
  await relay('broadcast-client-list');
}

/** Close every mobile companion session (used when rotating the pairing token). */
export async function wsKickAllMobile(): Promise<void> {
  await relay('kick-mobile');
}

/** Revoke a single companion client. */
export async function wsKickClient(clientId: string): Promise<void> {
  await relay('kick-client', { body: { clientId } });
}

/** Read the live companion client list (empty when the ws service is offline). */
export async function getWsClients(): Promise<RemoteClientPublicInfo[]> {
  const res = await relay('clients', { method: 'GET' });
  if (!res || !res.ok) return [];
  try {
    const data = (await res.json()) as { clients?: RemoteClientPublicInfo[] };
    return Array.isArray(data.clients) ? data.clients : [];
  } catch {
    return [];
  }
}

/** Read total websocket client counts (desktop consoles + mobile companions). */
export async function getWsStats(): Promise<{ total: number; desktop: number; mobile: number }> {
  const res = await relay('stats', { method: 'GET' });
  if (!res || !res.ok) return { total: 0, desktop: 0, mobile: 0 };
  try {
    return (await res.json()) as { total: number; desktop: number; mobile: number };
  } catch {
    return { total: 0, desktop: 0, mobile: 0 };
  }
}
