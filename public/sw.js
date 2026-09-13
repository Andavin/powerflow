/*
 * Service worker: only what Web Push needs.
 *
 * Served from /sw.js so its scope is the whole origin and a notification can
 * open any page. There is deliberately no `fetch` handler — the app isn't
 * offline-capable and has no cache strategy, and a pass-through handler would
 * route every request through this worker for nothing.
 */

// Take over as soon as an updated worker installs; there's no cached state
// for two versions to disagree about, so nothing is gained by waiting.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Always show *something*: a push that ends without a notification makes
  // the browser show its own "updated in the background", and after a few of
  // those it revokes the permission.
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = {};
    }
  }
  const path = typeof payload.path === "string" && payload.path.startsWith("/") ? payload.path : "/";

  event.waitUntil(
    self.registration.showNotification(payload.title || "Powerflow", {
      body: payload.body || "",
      tag: payload.tag || "powerflow",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { path },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || "/";

  event.waitUntil(
    (async () => {
      // Windows loaded before this worker activated are still the app; prefer
      // focusing one of those to opening a second copy beside it.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).pathname === path) return client.focus();
      }
      for (const client of clients) {
        if ("navigate" in client) {
          await client.focus();
          return client.navigate(path);
        }
      }
      return self.clients.openWindow(path);
    })(),
  );
});
