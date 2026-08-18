/* RIVER UNIVERSITY service worker: push notifications + light offline shell */
const CACHE = 'ru-here-v3';
const PRECACHE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

/* Standalone pages that live outside the app shell — the Spanish shell, plus the
   documents we open inside full-screen iframes. Each one caches itself and falls
   back to itself. Falling back to '/' here would render the entire app shell
   inside the iframe, which looks like the app opened itself in a window. */
const PAGES = [
  '/newspaper.html',
  '/booklist.html',
  '/handbook.html',
  '/handbook-es.html',
  '/index-es.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // PRECACHE is atomic on purpose: without these the app cannot boot offline.
      .then((c) => c.addAll(PRECACHE).then(() =>
        // PAGES is tolerant: a page that isn't deployed yet must not fail the
        // whole install and kill the service worker.
        Promise.all(PAGES.map((p) => c.add(p).catch(() => {})))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* network-first for navigations (fresh schedule data), cache fallback offline;
   cache-first for our small static assets */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate') {
    // A navigation is cached under its own path, and only if we recognise it.
    // Caching every navigation poisoned the offline shell when users visited
    // other pages (e.g. /admin.html) — their response became the '/' fallback.
    const key = (url.pathname === '/' || url.pathname === '/index.html') ? '/'
              : PAGES.indexOf(url.pathname) !== -1 ? url.pathname
              : null;
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (key && res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(key || '/'))
    );
    return;
  }
  if (url.origin === location.origin && /\.(png|jpe?g|webmanifest)$/.test(url.pathname)) {
    // cache-first with runtime fill: article images become readable offline after first view
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }))
    );
  }
});

/* ---- push ---- */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'RU HERE', body: e.data && e.data.text() }; }
  const title = data.title || 'RU HERE';
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: data.badge || '/icon-192.png',
      data: { url: data.url || '/' },
    }),
    // nudge any open window so the Messages unread badge updates without a reload
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((wins) => wins.forEach((w) => w.postMessage({ newMessage: true })))
      .catch(() => {}),
  ]));
});

/* Tapping a notification always lands on the Messages sheet rather than following
   the payload URL. Two reasons: the message stays readable (a tap that jumps
   straight out gives you nothing to come back to), and cross-origin targets are
   unreachable from here anyway — WindowClient.navigate() rejects for other
   origins and iOS blocks location.replace() out of a standalone PWA. The link
   itself is rendered as a button inside the message card. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.postMessage({ openMessages: true });
          return w.focus();
        }
      }
      return clients.openWindow('/?open=messages');
    })
  );
});
