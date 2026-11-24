/**
 * HKM FOH Companion service worker.
 *
 * This worker exists purely to satisfy the PWA installability requirement
 * (a registered SW with a fetch handler). The companion is an always-live
 * remote control: every state frame arrives over the WebSocket link and any
 * cached shell would risk a stale console — so nothing is ever cached and
 * every fetch passes straight through to the network.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Deliberate passthrough: no cache storage is opened, nothing is stored.
  event.respondWith(fetch(event.request));
});
