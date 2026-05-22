const CACHE = "tabino-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.ico",
  "./assets/milestones/sushi.png",
  "./assets/milestones/shinkansen.png",
  "./assets/milestones/matcha.png",
  "./assets/milestones/raimon.png",
  "./assets/milestones/s109.png",
  "./assets/milestones/beer.png",
  "./assets/milestones/tower.png",
  "./assets/milestones/maneki.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const requestUrl = new URL(e.request.url);

  if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
    return;
  }

  if (e.request.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await fetch(e.request);
        caches.open(CACHE).then(cache => cache.put("./index.html", res.clone())).catch(() => {});
        return res;
      } catch {
        return (await caches.match("./index.html")) || (await caches.match("./"));
      }
    })());
    return;
  }

  if (e.request.url.includes("workers.dev")) {
    e.respondWith((async () => {
      try {
        return await fetch(e.request);
      } catch {
        return new Response(JSON.stringify({ success: false, error: "API request failed" }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    })());
    return;
  }

  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request);
      if (cached) {
        return cached;
      }

      try {
        const res = await fetch(e.request);
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone)).catch(() => {});
        }
        return res;
      } catch {
        return cached || new Response("", { status: 504, statusText: "Offline" });
      }
    })()
  );
});
