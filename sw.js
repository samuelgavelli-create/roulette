/* Roulette di Casa - service worker
   Due compiti: tenere l'app apribile anche senza rete e ricevere le notifiche. */
const CACHE = 'roulette-v6';
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

/* Ogni avviso ha il suo tag: due notifiche diverse non si mangiano a vicenda.
   Il campo "vista" dice su quale schermata aprire l'app quando la tocchi. */
self.addEventListener('push', e => {
  let d = { titolo: 'Roulette di Casa', testo: 'Qualcosa si muove in casa.' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (_) {}
  const vista = d.vista || 'missioni';
  e.waitUntil(self.registration.showNotification(d.titolo, {
    body: d.testo,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || ('casa-' + Date.now()),
    renotify: true,
    vibrate: d.urgente ? [60, 40, 60, 40, 120] : [40, 30, 40],
    data: { url: './?v=' + encodeURIComponent(vista) }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => {
      for (const c of l) {
        if ('focus' in c) {
          if ('navigate' in c) { try { c.navigate(url); } catch (_) {} }
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
