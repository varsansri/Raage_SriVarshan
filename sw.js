/* Cache the shell so the countdown survives offline.
   Network-first for app files so deploys land immediately. */
const CACHE = 'raage-v8';
const SHELL = ['./', 'index.html', 'style.css', 'app.js',
               'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;  // never touch api.github.com
  // The journal is read fresh with a cachebust query on every load. Caching it
  // would both serve stale charts and grow the cache without bound.
  if (url.pathname.includes('/journal/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { caches.open(CACHE).then(c => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./')))
  );
});
