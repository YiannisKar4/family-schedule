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

// Push notifications (reminders, changes by others). The Edge Function sends
// { title, body, date, tag, who }; tapping one opens the app on that day's week.
// who is the person the notification is about (null: the app's logo). On Android its picture
// is their photo, or their initial on their colour. iPhone always shows the app's icon there,
// so the title starts with the coloured circle emoji closest to their colour instead.
const PHOTOS = 'schedule-photos'; // the app keeps each member's photo here, as photos/<id>
const apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && !/Chrome|Android|Edg/.test(navigator.userAgent);

const EMOJI = [['🔴', '#dd2e44'], ['🟠', '#f4900c'], ['🟡', '#fdcb58'], ['🟢', '#78b159'], ['🔵', '#55acee'],
  ['🟣', '#aa8ed6'], ['🟤', '#c1694f'], ['⚫', '#31373d'], ['⚪', '#e6e7e8']];
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function emoji(hex) {
  const c = rgb(hex);
  const dist = (e) => rgb(e[1]).reduce((sum, v, i) => sum + (v - c[i]) ** 2, 0);
  return EMOJI.reduce((best, e) => (dist(e) < dist(best) ? e : best))[0];
}

/** A round picture of the person, as a data URL; null when it cannot be drawn (the logo is used). */
async function picture(who) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const size = 192;
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d');
  g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.fillStyle = who.color; g.fill();
  let photo = null;
  if (who.photo) {
    const hit = await (await caches.open(PHOTOS)).match(`photos/${who.id}`);
    if (hit) photo = await createImageBitmap(await hit.blob()).catch(() => null);
  }
  if (photo) {
    // The photo inside a ring of the person's colour, as on the calendar.
    const r = size / 2 - 10;
    g.save(); g.beginPath(); g.arc(size / 2, size / 2, r, 0, Math.PI * 2); g.clip();
    g.drawImage(photo, size / 2 - r, size / 2 - r, r * 2, r * 2);
    g.restore();
  } else {
    g.fillStyle = '#fff'; g.font = '600 96px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((who.name || '?').charAt(0).toUpperCase(), size / 2, size / 2 + 6);
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

async function notify(m) {
  let title = m.title || 'Πρόγραμμα';
  let icon = 'icons/icon-192.png';
  if (m.who && /^#[0-9a-f]{6}$/i.test(m.who.color || '')) {
    if (apple) title = `${emoji(m.who.color)} ${title}`;
    else icon = (await picture(m.who).catch(() => null)) || icon;
  }
  return self.registration.showNotification(title, {
    body: m.body || '',
    tag: m.tag,
    icon,
    badge: 'icons/badge-96.png',
    data: { date: m.date },
  });
}

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: e.data && e.data.text() }; }
  e.waitUntil(notify(m));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const date = e.notification.data && e.notification.data.date;
  const url = new URL(date ? `./?d=${date}#week` : './#week', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    if (open) {
      open.postMessage({ type: 'open-day', date });
      return open.focus();
    }
    return self.clients.openWindow(url);
  }));
});
