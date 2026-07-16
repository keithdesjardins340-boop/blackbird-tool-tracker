// Offline-capable service worker with a NETWORK-FIRST strategy for the app
// shell, so a fresh deploy is always picked up when online; the cache is only a
// fallback when offline. Supabase API calls are never cached (always fresh).
const CACHE = 'bbt-shell-v8'; // bump on every deploy → old caches cleared + update toast fires
const SHELL = [
  '.', 'index.html', 'css/styles.css',
  'js/config.js', 'js/supabase.js', 'js/charts.js', 'js/app.js',
  'manifest.webmanifest', 'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.includes('/rest/v1/')) return; // API: always network, never cached

  // Network-first: fetch fresh, update cache, fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
  );
});
