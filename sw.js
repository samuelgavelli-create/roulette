/* Roulette di Casa - service worker
   Due compiti: tenere l'app apribile anche senza rete e ricevere le notifiche. */
const CACHE = 'roulette-v3';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Rete prima, cache come rete di sicurezza: così l'app resta sempre aggiornata
   ma si apre lo stesso se il telefono è senza campo. */
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  if (new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(r)
      .then(res => {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(r, copia)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(r).then(m => m || caches.match('./index.html')))
  );
});

self.addEventListener('push', e => {
  let d = { titolo: 'Roulette di Casa', testo: 'Qualcosa si muove in casa.' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.titolo, {
    body: d.testo,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || 'casa',
    renotify: true,
    data: { url: './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => {
      for (const c of l) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    })
  );
});
