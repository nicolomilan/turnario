// Turnario: l'app si apre subito e si legge anche senza rete.
// La pagina va sempre prima in rete (così ricevi gli aggiornamenti), le librerie restano in cache.
const V = 'turnario-v9';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.hostname.endsWith('supabase.co')) return; // i dati non passano dalla cache
  if (url.origin === location.origin) {
    // la pagina sempre fresca dal server (GitHub Pages altrimenti la tiene in cache 10 minuti)
    const fresh = req.mode === 'navigate' || /\.html?$|\/$/.test(url.pathname) ? new Request(req, { cache: 'no-store' }) : req;
    e.respondWith(fetch(fresh).then((r) => { const c = r.clone(); caches.open(V).then((x) => x.put(req, c)); return r; }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
    return;
  }
  if (/cdn\.jsdelivr\.net|unpkg\.com/.test(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => { const net = fetch(req).then((r) => { const c = r.clone(); caches.open(V).then((x) => x.put(req, c)); return r; }).catch(() => hit); return hit || net; }));
  }
});
