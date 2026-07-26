/**
 * Melodify Service Worker
 * ------------------------------------------------------------------
 * Caches the app shell (HTML/CSS/JS/fonts/icons) so Melodify launches
 * instantly and works offline. Deliberately does NOT cache anything
 * that must stay live: YouTube playback endpoints, Firestore, the
 * search API, or the lyrics API — those always hit the network.
 */

const CACHE_VERSION = "melodify-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./services/api.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
];

// Hosts whose responses must NEVER be cached — always go to the network.
const NEVER_CACHE_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
  "ytimg.com",
  "googlevideo.com",
  "firestore.googleapis.com",
  "firebaseio.com",
  "googleapis.com",
  "lrclib.net",
];

function isNeverCache(url) {
  try {
    const host = new URL(url).host;
    return NEVER_CACHE_HOSTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

function isFont(url) {
  return /fonts\.(googleapis|gstatic)\.com/.test(url);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn("[SW] Precache failed", err))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("melodify-") && key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = request.url;

  // Never intercept requests to services that must always be live.
  if (isNeverCache(url)) return;

  // App shell files: network-first so updates are picked up quickly,
  // falling back to cache (and finally the offline page) when offline.
  const isNavigation = request.mode === "navigate";
  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")).then((res) => res || caches.match("./offline.html")))
    );
    return;
  }

  // Fonts and static assets: cache-first, refresh in the background.
  if (isFont(url) || APP_SHELL.some((path) => url.endsWith(path.replace("./", "")))) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Everything else same-origin (images, scripts): stale-while-revalidate.
  if (url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});
