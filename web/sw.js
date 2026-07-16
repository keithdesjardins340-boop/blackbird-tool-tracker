// Offline-capable service worker with a NETWORK-FIRST strategy for the app
// shell, so a fresh deploy is always picked up when online; the cache is only a
// fallback when offline. Supabase API calls are never cached (always fresh).
// DEPLOY_STAMP: deploy-web.yml rewrites this exact line with the commit SHA
// before publishing, so every deploy gets a unique cache name automatically —
// old caches are cleared and the update toast fires without anyone remembering
// to bump a number. Don't reword the line; the deploy asserts it matched.
// It stays 'bbt-shell-dev' in the repo (and when serving /web locally, which is
// what keeps /web build-step-free for development).
const CACHE = 'bbt-shell-dev'; // DEPLOY_STAMP
const SHELL = [
  '.', 'index.html', 'css/styles.css',
  // constants.js is imported BY app.js, so it must be precached too — a module
  // import that misses the cache takes the whole app down offline, and the
  // checklist is exactly what he needs in a basement with no signal.
  'js/config.js', 'js/constants.js', 'js/supabase.js', 'js/charts.js', 'js/app.js',
  'manifest.webmanifest', 'icon.svg',
];

self.addEventListener('install', (e) => {
  // cache:'reload' so the precache can't be filled from a stale HTTP cache — a
  // fresh worker must start from freshly-fetched files, not yesterday's copies.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
  //
  // `cache: 'no-cache'` is load-bearing: a plain fetch() still consults the
  // BROWSER's HTTP cache, and Pages serves the shell with a max-age — so after a
  // deploy the worker would "go to the network", get a stale app.js back, and
  // then cache that as the newest copy. The page would keep running old code for
  // up to the max-age even after a reload. 'no-cache' forces a revalidation
  // (cheap: a 304 when nothing changed), so a deploy is picked up immediately.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
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
