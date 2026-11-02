/* Cache-first for parsed rounds and blockouts. Keeps the 4 most recent matches. */
const CACHE = "cs2clips-replay-v1";
const MAX_MATCHES = 4;
const LRU = "/__cs2clips_lru";

function matchId(url) {
  const m = url.pathname.match(/\/api\/matches\/([a-f0-9]{16})\//);
  return m ? m[1] : null;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function readLru(cache) {
  const hit = await cache.match(LRU);
  if (!hit) return [];
  try { return await hit.json(); } catch { return []; }
}

async function remember(cache, id) {
  const order = (await readLru(cache)).filter((x) => x !== id);
  order.unshift(id);
  const keep = new Set(order.slice(0, MAX_MATCHES));
  const keys = await cache.keys();
  await Promise.all(keys.map(async (req) => {
    const mid = matchId(new URL(req.url));
    if (mid && !keep.has(mid)) await cache.delete(req);
  }));
  await cache.put(LRU, new Response(JSON.stringify(order.slice(0, MAX_MATCHES)), {
    headers: { "Content-Type": "application/json" },
  }));
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (!/\/api\/matches\/[a-f0-9]{16}\/(rounds\/\d+|blockout|timeline)$/.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) {
      const id = matchId(url);
      if (id) remember(cache, id);
      return cached;
    }
    const fresh = await fetch(event.request);
    if (fresh.ok) {
      await cache.put(event.request, fresh.clone());
      const id = matchId(url);
      if (id) await remember(cache, id);
    }
    return fresh;
  })());
});
