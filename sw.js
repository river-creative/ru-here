/* FIRE CONF service worker: push notifications + light offline shell */
const CACHE = 'fireconf-v2';
const PRECACHE = ['/', '/newspaper.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/cor/paper-grain.png', '/cor/p01-0.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
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
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // Only the app shell may refresh the '/' cache entry. Caching every
          // navigation here poisoned the offline shell when users visited other
          // pages (e.g. /admin.html) — their response became the '/' fallback.
          if (url.pathname === '/' || url.pathname === '/index.html') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
          } else if (url.pathname === '/newspaper.html') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/newspaper.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(url.pathname === '/newspaper.html' ? '/newspaper.html' : '/'))
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
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'FIRE CONF', body: e.data && e.data.text() }; }
  const title = data.title || 'FIRE CONF';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          // iOS does not implement WindowClient.navigate() — message the page
          // so it navigates itself; keep navigate() for Android/desktop.
          w.postMessage({ nav: url });
          if (w.navigate) { try { w.navigate(url).catch(() => {}); } catch (err) {} }
          return w.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
