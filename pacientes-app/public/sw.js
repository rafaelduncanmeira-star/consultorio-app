// Service worker mínimo do M1: garante instalabilidade da PWA.
// Cache/offline e Web Push entram no M3 (lembretes).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // pass-through: rede normal
});
