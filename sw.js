// Service Worker para o Consultório App
// Estratégia: network-first com fallback para cache (para um app que muda muito,
// é melhor sempre tentar a rede primeiro e só cair no cache se estiver offline).

const CACHE_NAME = 'consultorio-v2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png',
  './apple-touch-icon.png',
];

// Install — pré-cacheia o shell do app
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// Activate — limpa caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-first
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Só intercepta GET e mesma origem (Supabase, CDNs, etc. passam direto)
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Atualiza o cache em background com a resposta nova
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone).catch(() => {}));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
