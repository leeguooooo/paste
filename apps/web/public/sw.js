const CACHE_PREFIX = "pastyx-";
const CACHE_NAME = "pastyx-v2";
const APP_SHELL_PATH = "/index.html";
const PRECACHE_PATHS = [APP_SHELL_PATH, "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_PATHS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Keep hashed assets network-driven. Only navigations fall back to cached shell.
  if (event.request.mode !== "navigate") {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const networkResponse = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(APP_SHELL_PATH, networkResponse.clone());
        return networkResponse;
      } catch (error) {
        const cachedShell = await caches.match(APP_SHELL_PATH);
        if (cachedShell) {
          return cachedShell;
        }
        throw error;
      }
    })()
  );
});
