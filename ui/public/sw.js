// OpenClaw Control – Service Worker
// Handles offline caching and push notifications.

const CACHE_PREFIX = "openclaw-control-";
const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";
const URL_CACHE_VERSION = new URL(self.location.href).searchParams
  .get("v")
  ?.replace(/[^a-zA-Z0-9._-]/g, "-");
const CACHE_VERSION =
  (EMBEDDED_CACHE_VERSION !== "__OPENCLAW_CONTROL_UI_BUILD_ID__"
    ? EMBEDDED_CACHE_VERSION
    : URL_CACHE_VERSION) || "dev";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const CONTROL_CACHE_LIMIT = 3;

// Minimal app-shell files to precache.
const PRECACHE_URLS = ["./"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const [cacheKeys, windowClients] = await Promise.all([
        caches.keys(),
        self.clients.matchAll({ type: "window", includeUncontrolled: true }),
      ]);
      const controlKeys = cacheKeys.filter((key) => key.startsWith(CACHE_PREFIX));
      const priorCacheLimit = Math.max(0, CONTROL_CACHE_LIMIT - 1);
      // Keep a small prior-build window so open tabs can still load old hashed chunks after updates.
      const retained = new Set([
        ...controlKeys.filter((key) => key !== CACHE_NAME).slice(-priorCacheLimit),
        CACHE_NAME,
      ]);

      await Promise.all([
        self.clients.claim(),
        Promise.all(
          controlKeys.filter((key) => !retained.has(key)).map((key) => caches.delete(key)),
        ),
      ]);

      for (const client of windowClients) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Service Worker Client.postMessage does not take targetOrigin.
        client.postMessage({ type: "sw-updated", version: CACHE_VERSION });
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Skip top-level navigations so the browser can handle HTTP auth
  // challenges natively — WWW-Authenticate dialogs are bypassed when the
  // response comes from a service worker, breaking reverse-proxy setups
  // with basic/digest auth in front of the gateway.
  if (event.request.mode === "navigate") {
    return;
  }

  // Skip non-UI routes — API, RPC, and plugin routes should never be cached.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/plugins/")
  ) {
    return;
  }

  // Cache-first for hashed assets; network-first for HTML/other.
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          }),
      ),
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
  }
});

// --- Web Push ---

self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "OpenClaw", body: event.data.text() };
  }

  const title = data.title || "OpenClaw";
  const options = {
    body: data.body || "",
    icon: "./apple-touch-icon.png",
    badge: "./favicon-32.png",
    tag: data.tag || "openclaw-notification",
    data: {
      url: data.url || self.registration.scope,
      explicitUrl: Boolean(data.url),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const scopeUrl = new URL(self.registration.scope);
  const scopePath = scopeUrl.pathname.endsWith("/") ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
  // Relative targets belong beneath the registered scope even when its URL
  // omits a trailing slash; keep the exact scope for default navigation.
  const scopeNavigationBase = new URL(scopePath, scopeUrl);
  const notificationUrl = event.notification.data?.url;
  // Notifications shown before an update stored "./" for implicit targets.
  // Preserve their existing in-scope tabs when the new worker handles the click.
  const hasExplicitTarget =
    event.notification.data?.explicitUrl ?? Boolean(notificationUrl && notificationUrl !== "./");
  const isInScope = (url) =>
    url.origin === scopeUrl.origin &&
    (url.pathname === scopeUrl.pathname || url.pathname.startsWith(scopePath));

  let targetUrl = scopeUrl;
  try {
    const requestedUrl = new URL(
      (hasExplicitTarget ? notificationUrl : undefined) || scopeUrl.href,
      scopeNavigationBase,
    );
    if (isInScope(requestedUrl)) {
      targetUrl = requestedUrl;
    }
  } catch {
    // Malformed notification targets can only fall back to the registered app scope.
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      let targetClient;
      let targetClientRank = -1;
      for (const client of clients) {
        let clientUrl;
        try {
          clientUrl = new URL(client.url);
        } catch {
          continue;
        }

        if (!isInScope(clientUrl)) {
          continue;
        }
        if (!hasExplicitTarget) {
          return client.focus();
        }

        // Prefer the existing target tab before repurposing another app tab.
        // Client.url can lag SPA history, so its match only chooses a candidate.
        const clientRank =
          clientUrl.href === targetUrl.href
            ? 3
            : clientUrl.pathname === targetUrl.pathname
              ? clientUrl.search === targetUrl.search
                ? 2
                : 1
              : 0;
        if (clientRank > targetClientRank) {
          targetClient = client;
          targetClientRank = clientRank;
          if (clientRank === 3) {
            break;
          }
        }
      }

      if (!targetClient) {
        return self.clients.openWindow(targetUrl.href);
      }

      // Always navigate explicit targets; old or uncontrolled workers can
      // reject navigation, so preserve the validated open-window fallback.
      return targetClient
        .navigate(targetUrl.href)
        .then((navigatedClient) => (navigatedClient ?? targetClient).focus())
        .catch(() => self.clients.openWindow(targetUrl.href));
    }),
  );
});
