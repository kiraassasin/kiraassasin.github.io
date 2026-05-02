'use strict';

/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER — Reliable, Real-time, High Performance

   PRINSIP DESAIN:
   ┌─────────────────────────────────────────────────────────┐
   │ 1. Image cache TIDAK PERNAH dihapus saat versi update   │
   │    → URL Cloudinary immutable: URL sama = gambar sama   │
   │                                                         │
   │ 2. Version update = kirim data baru ke halaman saja     │
   │    → Halaman apply real-time tanpa reload               │
   │                                                         │
   │ 3. data.json selalu fresh dari network                  │
   │    → Cache hanya sebagai fallback offline               │
   │                                                         │
   │ 4. Cara update: ubah "version" di data.json → push      │
   └─────────────────────────────────────────────────────────┘
═══════════════════════════════════════════════════════════════ */

const SW_VER      = 'v5';
const CACHE_FONT  = 'font-'  + SW_VER;
const CACHE_SHELL = 'shell-' + SW_VER;
const CACHE_DATA  = 'data-'  + SW_VER;

let knownVersion  = null;                 // Version terakhir yang diketahui

/* ──────────────────────────────────────────────────────────────
   INSTALL
────────────────────────────────────────────────────────────── */
self.addEventListener('install', evt => {
  // Langsung aktif tanpa menunggu tab lama tutup
  self.skipWaiting();
  evt.waitUntil(
    caches.open(CACHE_SHELL).then(c => {
      // Graceful — tidak fail install jika asset belum ada
      return Promise.allSettled([
        c.add('/'),
        c.add('/index.html'),
      ]);
    })
  );
});

/* ──────────────────────────────────────────────────────────────
   ACTIVATE — bersihkan cache SW lama
────────────────────────────────────────────────────────────── */
self.addEventListener('activate', evt => {
  evt.waitUntil(
    (async () => {
      // Hapus cache dari SW versi lama
      const validCaches = new Set([CACHE_FONT, CACHE_SHELL, CACHE_DATA]);
      const allKeys = await caches.keys();
      await Promise.all(
        allKeys
          .filter(k => !validCaches.has(k))
          .map(k => {
            console.log('[SW] Hapus cache lama:', k);
            return caches.delete(k);
          })
      );
      await self.clients.claim();
    })()
  );
});

/* ──────────────────────────────────────────────────────────────
   FETCH ROUTER
────────────────────────────────────────────────────────────── */
self.addEventListener('fetch', evt => {
  if (evt.request.method !== 'GET') return;

  const url = new URL(evt.request.url);

  // ── Gambar Cloudinary → JANGAN diintersep
  // Browser punya HTTP cache bawaan yang lebih andal untuk cross-origin.
  // SW fetch cross-origin Cloudinary sering gagal (opaque response / CORS).
  if (url.hostname === 'res.cloudinary.com') return;

  // ── Gambar eksternal lain (Unsplash, dll) → jangan diintersep
  if (evt.request.destination === 'image' && url.origin !== self.location.origin) return;

  // ── data.json → Network-first, versi dicheck, fallback cache
  if (url.pathname.endsWith('data.json')) {
    evt.respondWith(handleData(evt.request));
    return;
  }

  // ── Google Fonts → Cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    evt.respondWith(handleFont(evt.request));
    return;
  }

  // ── HTML page → Stale-while-revalidate
  if (evt.request.destination === 'document') {
    evt.respondWith(handleShell(evt.request));
    return;
  }

  // ── Lainnya (same-origin) → network dengan fallback cache
  evt.respondWith(
    fetch(evt.request).catch(() => caches.match(evt.request))
  );
});

/* ──────────────────────────────────────────────────────────────
   HANDLER: data.json
   Strategi: Network → cek versi → notify page jika berubah
             Jika offline → kembalikan cache (tidak hapus apapun)
────────────────────────────────────────────────────────────── */
async function handleData(req) {
  // Buat URL bersih ke data.json (hindari masalah path relatif)
  const cleanUrl = new URL(DATA_PATH, req.url).href;

  // ── Coba network first ──────────────────────────────────────
  try {
    const netRes = await fetch(cleanUrl, {
      cache: 'no-store',                  // Bypass browser HTTP cache
      headers: { 'Accept': 'application/json' },
    });

    if (!netRes.ok) throw new Error('HTTP ' + netRes.status);

    const text = await netRes.text();
    const data = JSON.parse(text);        // Validasi JSON

    // Simpan ke cache sebagai fallback offline
    const cache = await caches.open(CACHE_DATA);
    await cache.put(cleanUrl, new Response(text, {
      headers: { 'Content-Type': 'application/json' }
    }));

    // Cek apakah versi berubah
    const newVer = String(data.version || '0');
    if (knownVersion && knownVersion !== newVer) {
      console.log('[SW] Versi berubah:', knownVersion, '→', newVer);
      // PENTING: tidak menghapus cache gambar!
      // Hanya kirim data baru ke semua tab
      await broadcastUpdate(newVer, data);
    }
    knownVersion = newVer;

    return new Response(text, { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    // ── Offline atau error → kembalikan dari cache ────────────
    console.debug('[SW] data.json offline, pakai cache:', err.message);
    const cached = await caches.match(cleanUrl, { cacheName: CACHE_DATA })
                || await caches.match('/data.json', { cacheName: CACHE_DATA });
    if (cached) return cached;

    // Tidak ada cache sama sekali
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }
}

/* ──────────────────────────────────────────────────────────────
   HANDLER: Google Fonts
────────────────────────────────────────────────────────────── */
async function handleFont(req) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const fresh = await fetch(req);
    if (fresh.ok) {
      const cache = await caches.open(CACHE_FONT);
      await cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    return cached || new Response('', { status: 408 });
  }
}

/* ──────────────────────────────────────────────────────────────
   HANDLER: HTML shell
   Strategi: Stale-while-revalidate
   Return cache langsung (cepat) + update di background
────────────────────────────────────────────────────────────── */
async function handleShell(req) {
  const cached = await caches.match(req, { cacheName: CACHE_SHELL });

  // Fetch di background untuk update cache berikutnya
  const networkFetch = fetch(req)
    .then(fresh => {
      if (fresh.ok) {
        caches.open(CACHE_SHELL)
          .then(c => c.put(req, fresh.clone()))
          .catch(() => {});
      }
      return fresh;
    })
    .catch(() => null);

  if (cached) {
    // Return cache langsung, network jalan di background
    networkFetch; // fire and forget
    return cached;
  }

  // Tidak ada cache — tunggu network
  const fresh = await networkFetch;
  return fresh || new Response('', { status: 408 });
}

/* ──────────────────────────────────────────────────────────────
   BROADCAST UPDATE ke semua tab
────────────────────────────────────────────────────────────── */
async function broadcastUpdate(version, data) {
  try {
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    clients.forEach(client => {
      client.postMessage({ type: 'VERSION_UPDATE', version, data });
    });
    console.log('[SW] Broadcast ke', clients.length, 'tab(s)');
  } catch (_) {}
}

/* ──────────────────────────────────────────────────────────────
   PESAN DARI CLIENT
────────────────────────────────────────────────────────────── */
self.addEventListener('message', evt => {
  if (!evt.data) return;
  switch (evt.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'GET_VERSION':
      // Client tanya versi saat ini
      evt.source?.postMessage({ type: 'CURRENT_VERSION', version: knownVersion });
      break;
  }
});
