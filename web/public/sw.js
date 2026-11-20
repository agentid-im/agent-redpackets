// Service worker: makes the site an installable web app that opens offline.
// - Pages: network first (always the latest site), the cached shell only when offline.
// - Build assets (/assets/*, hashed names), fonts and icons: cache first; they never change in place.
// - /api, /og cards, share pages' data and anything cross-origin: straight to the network, never cached.
const SHELL = "ahb-shell-v1";
const STATIC = "ahb-static-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/icon.svg", "/manifest.webmanifest"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/og/") || url.pathname.startsWith("/skill/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname === "/") caches.open(SHELL).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(() => caches.match("/", { ignoreSearch: true }))
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/") || /\.(png|svg|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) c.put(req, res.clone());
              return res;
            })
        )
      )
    );
  }
});
