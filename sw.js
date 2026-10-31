/* Roulette di Casa · 1.0.1 — service worker
   Tre compiti: tenere l'app apribile anche senza rete, ricevere le notifiche e,
   su Android, segnare «✓ Fatto» direttamente dal pulsante della notifica.     */
const CACHE = 'roulette-alpha101';
const CFG = 'roulette-cfg';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './badge-96.png'];

self.addEventListener('install', e => {
  /* un file mancante non deve bloccare l'aggiornamento: ognuno si mette in cache per conto suo */
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CFG).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Rete prima, cache come rete di sicurezza: l'app resta sempre aggiornata
   ma si apre lo stesso se il telefono è senza campo. */
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  if (new URL(r.url).origin !== self.location.origin) return;
  /* le aperture dell'app (anche da notifica, con ?v=…) finiscono tutte sotto la stessa voce */
  const chiave = r.mode === 'navigate' ? './' : r;
  e.respondWith(
    fetch(r)
      .then(res => {
        if (res && res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(chiave, copia)).catch(() => {}); }
        return res;
      })
      .catch(() => caches.match(chiave, { ignoreSearch: true })
        .then(m => m || caches.match('./'))
        .then(m => m || caches.match('./index.html')))
  );
});

/* l'app manda l'indirizzo di Supabase e il codice della casa: servono al pulsante «Fatto» */
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.tipo === 'cfg' && d.u && d.c) {
    e.waitUntil(caches.open(CFG).then(c => c.put('./__cfg', new Response(JSON.stringify({ u: d.u, c: d.c }), { headers: { 'Content-Type': 'application/json' } }))));
  }
});
async function leggiCfg() {
  try { const c = await caches.open(CFG); const r = await c.match('./__cfg'); return r ? await r.json() : null; } catch (_) { return null; }
}

/* il tag dice cosa si può fare dalla notifica: a1|tipo|chiave */
function azioni(tag) {
  const p = String(tag || '').split('|');
  if (p[0] !== 'a1') return [];
  if (['bid', 'bidn', 'ser', 'fla'].includes(p[1]) || (p[1] === 'mis' && p[2])) return [{ action: 'fatto', title: '✓ Fatto' }];
  if (p[1] === 'lav') return [{ action: 'fatto', title: 'Stendo io' }];
  return [];
}

/* Ogni avviso ha il suo tag: due notifiche diverse non si mangiano a vicenda.
   Il campo "vista" dice su quale schermata aprire l'app quando la tocchi. */
self.addEventListener('push', e => {
  let d = { titolo: 'Roulette di Casa', testo: 'Qualcosa si muove in casa.' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (_) {}
  const vista = d.vista || 'oggi';
  const tag = d.tag || ('casa-' + Date.now());
  e.waitUntil(self.registration.showNotification(d.titolo, {
    body: d.testo,
    icon: './icon-192.png',
    /* il badge di Android dev'essere una sagoma bianca su fondo trasparente */
    badge: './badge-96.png',
    tag: tag,
    renotify: true,
    vibrate: d.urgente ? [60, 40, 60, 40, 120] : [40, 30, 40],
    actions: azioni(tag),
    data: { url: './?v=' + encodeURIComponent(vista), tag: tag, vista: vista }
  }));
});

async function apri(url) {
  const l = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of l) {
    if ('focus' in c) {
      if ('navigate' in c) { try { await c.navigate(url); } catch (_) {} }
      return c.focus();
    }
  }
  return self.clients.openWindow(url);
}

/* «✓ Fatto» dalla notifica: si segna senza aprire l'app. Se non riesce (niente rete,
   telefono non iscritto…) si apre l'app, che segna da sola e dice com'è andata. */
async function segna(tag, dati) {
  const cfg = await leggiCfg();
  let sub = null, esito = null;
  try { sub = await self.registration.pushManager.getSubscription(); } catch (_) {}
  if (cfg && sub) {
    /* al massimo 4 secondi: dopo, Android non lascerebbe più aprire l'app come piano B */
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 4000);
    try {
      const r = await fetch(cfg.u + '/functions/v1/sveglia', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ tocco: { casa: cfg.c, tag: tag, endpoint: sub.endpoint } }),
        signal: ctrl ? ctrl.signal : undefined
      });
      esito = await r.json();
    } catch (_) { esito = null; }
    clearTimeout(timer);
  }
  if (esito && (esito.ok || esito.gia)) {
    await self.registration.showNotification(esito.ok ? (esito.titolo || 'Segnato ✓') : 'Era già segnato', {
      body: esito.ok ? (esito.testo || 'Fatto.') : (esito.msg || ''),
      icon: './icon-192.png', badge: './badge-96.png', tag: tag, renotify: false, silent: true,
      data: { url: './?v=' + encodeURIComponent((dati && dati.vista) || 'oggi'), tag: tag }
    });
    const l = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    l.forEach(c => c.postMessage({ tipo: 'aggiorna' }));
    /* la conferma sparisce da sola dopo qualche secondo */
    await new Promise(r => setTimeout(r, 5000));
    const n = await self.registration.getNotifications({ tag: tag });
    n.forEach(x => x.close());
    return;
  }
  return apri('./?v=' + encodeURIComponent((dati && dati.vista) || 'oggi') + '&fatto=' + encodeURIComponent(tag));
}

self.addEventListener('notificationclick', e => {
  const n = e.notification, dati = n.data || {}, tag = dati.tag || n.tag;
  n.close();
  if (e.action === 'fatto') { e.waitUntil(segna(tag, dati)); return; }
  e.waitUntil(apri(dati.url || './'));
});
