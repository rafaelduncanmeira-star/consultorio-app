// Service Worker para o Consultório App
// Estratégia: network-first com fallback para cache (para um app que muda muito,
// é melhor sempre tentar a rede primeiro e só cair no cache se estiver offline).

// v3: o activate apaga os caches de nome diferente, então subir a versão é o
// que limpa a resposta ruim que a v2 podia ter gravado (ver o fetch abaixo).
const CACHE_NAME = 'consultorio-v3';
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
        // Só guarda resposta BOA. Sem o res.ok, um 500 ou uma página de erro
        // servida durante um deploy era gravada no lugar do app.js — e a
        // próxima abertura offline entregava esse lixo como se fosse o app.
        if (res && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone).catch(() => {}));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => {
        if (cached) return cached;
        // index.html só responde por NAVEGAÇÃO. Devolver o HTML no lugar de um
        // .js ou de uma imagem não salva nada: o navegador tenta executar
        // HTML como script e a página quebra de um jeito bem mais confuso do
        // que uma falha de rede honesta.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
