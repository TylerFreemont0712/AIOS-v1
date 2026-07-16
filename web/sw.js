// Minimal service worker: AIOS is LAN-local, so no offline caching games — this
// exists to make the PWA installable everywhere. Straight network passthrough.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  // passthrough — respondWith is intentionally not called
});
