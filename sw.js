// sw.js — service worker SOURCE. The vite pwa plugin (vite.config.ts) stamps
// the VERSION + PRECACHE placeholders per build and emits dist/sw.js.
// Edit this file, not the built copy.

const VERSION = '__VERSION__';
const CACHE = `goc-war-${VERSION}`;
const PRECACHE = /*__PRECACHE__*/[];

// font CDN (loli.net mirror) — offline-tolerant via stale-while-revalidate
const FONT_ORIGINS = ['https://fonts.loli.net', 'https://gstatic.loli.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('goc-war-') && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // navigations: fresh shell when online, cached shell when offline
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // font CDN: serve cached instantly, refresh in background
  if (FONT_ORIGINS.includes(url.origin)) {
    e.respondWith(
      caches.match(request).then((hit) => {
        const net = fetch(request)
          .then((res) => {
            if (res.ok || res.type === 'opaque') {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }

  // same-origin statics (hashed assets, wasm, icons): cache-first + backfill
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});
