// Network-first for everything (always the latest deploy when online),
// cache only as an offline fallback. Bump VERSION on every deploy.
const VERSION = "bormar-replay-v3";
const ASSETS = [
  "./", "index.html", "css/app.css",
  "js/app.js", "js/sim.js", "js/render.js", "js/video.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() =>
      caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))
    )
  );
});
