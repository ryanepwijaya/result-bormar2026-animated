// Bump VERSION whenever app files or data change.
const VERSION = "bormar-replay-v1";
const ASSETS = [
  "./", "index.html", "css/app.css",
  "js/app.js", "js/sim.js", "js/render.js", "js/video.js",
  "data/fm.json", "data/hm.json", "data/10k.json",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  // Navigation: network first so new deploys show up, cache as offline fallback.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => {
      const copy = r.clone(); caches.open(VERSION).then((c) => c.put("index.html", copy));
      return r;
    }).catch(() => caches.match("index.html")));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return r;
  })));
});
