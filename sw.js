// The Planner: works offline.
// The app page and the libraries it uses are kept on this device, so it opens without a connection.
// The page is served from that copy straight away; when online, a fresh copy is fetched in the background
// and, if it differs, the open app is told so it can offer "Reload" (otherwise it's used next time).
// Calendar feeds (/feed/), shared trips (/share/), sign-in and data requests always go to the network.
const APP = 'planner-app-v1';
const LIB = 'planner-lib-v1';
const LIB_HOSTS = ['d3js.org', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'flagcdn.com'];
const LIBS = [
  'https://d3js.org/d3.v7.min.js',
  'https://cdn.jsdelivr.net/npm/topojson-client@3',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js',
  'https://unpkg.com/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&display=swap',
];
const PAGE = new URL('./', self.registration.scope).pathname; // "/" on the live site

const pageKey = url => {
  const p = new URL(url).pathname;
  return p === PAGE || p === PAGE + 'index.html' ? p : null;
};
// Text recognition (Smart Upload scans) is large and needs a connection anyway: never stored
const isLib = url => { const u = new URL(url); return LIB_HOSTS.includes(u.hostname) && !/tesseract/i.test(u.pathname); };
const corsFetch = url => fetch(url, { mode: 'cors', credentials: 'omit' });

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const app = await caches.open(APP);
    const r = await fetch(PAGE, { cache: 'no-store' });
    if (r.ok) await app.put(PAGE, r);
    const lib = await caches.open(LIB);
    // One failing library mustn't stop the rest (it's fetched again when the app asks for it)
    await Promise.all(LIBS.map(async u => { try { if (!(await lib.match(u))) { const x = await corsFetch(u); if (x.ok) await lib.put(u, x); } } catch (err) {} }));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== LIB) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Fetch the page again; if it changed, keep the new copy and tell open windows
let checking = null;
function checkForUpdate(key) {
  if (checking) return checking;
  checking = (async () => {
    try {
      const app = await caches.open(APP);
      const old = await app.match(key);
      const r = await fetch(key, { cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('text/html')) return;
      const text = await r.clone().text();
      if (old && (await old.text()) === text) return;
      await app.put(key, r);
      if (old) for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'update-ready' });
    } catch (err) { /* offline: keep what we have */ }
    finally { checking = null; }
  })();
  return checking;
}

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'check-update') e.waitUntil(checkForUpdate(pageKey(d.url || self.registration.scope) || PAGE));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    const key = pageKey(req.url);
    if (!key) return; // /feed/, /share/ and anything else: network as usual
    e.respondWith((async () => {
      const app = await caches.open(APP);
      const hit = await app.match(key);
      if (hit) { e.waitUntil(checkForUpdate(key)); return hit; }
      try {
        const r = await fetch(req);
        if (r.ok) await app.put(key, r.clone());
        return r;
      } catch (err) {
        return (await app.match(PAGE)) || Response.error();
      }
    })());
    return;
  }

  if (isLib(req.url)) {
    e.respondWith((async () => {
      const lib = await caches.open(LIB);
      const hit = await lib.match(req.url);
      if (hit) return hit;
      try {
        const r = await corsFetch(req.url);
        if (r.ok) await lib.put(req.url, r.clone());
        return r;
      } catch (err) {
        try { return await fetch(req); } catch (err2) { return Response.error(); }
      }
    })());
  }
});
