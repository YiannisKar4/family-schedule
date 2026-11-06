// Lets the site install as an app and open without a connection.
// Only this site's own files are cached. Supabase (data, sign-in, live updates) and the
// place search are on other origins and always go straight to the network.
const CACHE = 'schedule-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // The page: always the latest from the network, so a deploy shows up on the next open.
  // The saved copy is only for when there is no connection.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./', copy)); }
        return res;
      }).catch(() => caches.match('./'))
    );
    return;
  }

  // Scripts and styles carry ?v=, which changes with every release, so a saved copy is never
  // stale: serve it, and fetch it once if missing. Everything else (icons, manifest): network
  // first, saved copy when offline.
  const save = (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };
  if (new URL(req.url).searchParams.has('v')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(save)));
  } else {
    e.respondWith(fetch(req).then(save).catch(() => caches.match(req)));
  }
});
