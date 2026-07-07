// ===================================================================
//  sw.js — service worker
//  Strategy: NETWORK-FIRST for the app shell so you always get the
//  latest version when online, with a cache fallback for offline use.
//  (Firestore handles its own data offline separately.)
// ===================================================================
const CACHE = "ac-tracker-v3";
const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/db.js",
  "./js/local-store.js",
  "./js/scanner.js",
  "./js/firebase-config.js",
  "./manifest.json",
  "./data.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never touch Firebase / Google APIs — always go straight to network.
  if (url.hostname.includes("googleapis.com") ||
      url.hostname.includes("gstatic.com") ||
      url.hostname.includes("firebase") ||
      url.hostname.includes("unpkg.com")) return;

  // Only handle same-origin GET requests.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network-first, and BYPASS the browser HTTP cache ({cache:"reload"}) so a
  // freshly deployed version always wins when online. Fall back to the SW
  // cache only when offline.
  e.respondWith(
    fetch(e.request.url, { cache: "reload" })
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});
