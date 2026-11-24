/**
 * WebSocket relay URL resolution for the HKM companion / desktop link.
 *
 * Transport strategy (best practice for LAN-deployed consoles):
 *  1. PRIMARY — same-origin `/ws?…&XTransformPort=3030`: works through the
 *     sandbox/preview gateway (Caddy) and any reverse proxy that maps the
 *     XTransformPort query param to the audio-ws service on :3030.
 *  2. FALLBACK — direct `ws(s)://<same-host>:3030/ws?…`: when a phone reaches
 *     a desktop console directly on the LAN (no gateway in front), the
 *     Next.js server cannot proxy WebSocket upgrades, so the client connects
 *     straight to the audio-ws mini-service bound on port 3030 of the same
 *     host.
 *
 * Both URLs share the same query string; callers pass role/token/device.
 */
export function buildRelayWsUrls(params: Record<string, string>): string[] {
  if (typeof window === 'undefined') return [];
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams(params).toString();
  return [
    `${proto}//${window.location.host}/ws?${qs}&XTransformPort=3030`,
    `${proto}//${window.location.hostname}:3030/ws?${qs}`,
  ];
}
