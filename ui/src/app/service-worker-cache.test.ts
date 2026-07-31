// Control UI tests cover service worker cache behavior.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerPath = path.join(here, "../../public/sw.js");

describe("Control UI service worker cache versioning", () => {
  it("registers the service worker with a build id and bounds prior build caches", () => {
    const mainSource = fs.readFileSync(path.join(here, "../main.ts"), "utf8");
    const serviceWorkerSource = fs.readFileSync(serviceWorkerPath, "utf8");
    const viteConfigSource = fs.readFileSync(path.join(here, "../../vite.config.ts"), "utf8");

    expect(mainSource).toContain('swUrl.searchParams.set("v"');
    expect(mainSource).toContain("CONTROL_UI_BUILD_INFO.buildId");
    expect(mainSource).toContain('updateViaCache: "none"');
    expect(mainSource).toContain('navigator.serviceWorker.addEventListener("message"');
    expect(mainSource).toContain("event.data.version !== currentControlUiBuildId");
    expect(serviceWorkerSource).toContain(
      'const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__"',
    );
    expect(serviceWorkerSource).toContain("URL_CACHE_VERSION");
    expect(serviceWorkerSource).toContain("CONTROL_CACHE_LIMIT = 3");
    expect(serviceWorkerSource).toContain("slice(-priorCacheLimit)");
    expect(serviceWorkerSource).toContain("caches.delete");
    expect(serviceWorkerSource).toContain("includeUncontrolled: true");
    expect(serviceWorkerSource).not.toContain(
      'postMessage({ type: "sw-updated", version: CACHE_VERSION },',
    );
    expect(viteConfigSource).toContain("source.replace(placeholder, JSON.stringify(buildId))");
    expect(viteConfigSource).toContain(
      '"globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(buildInfo)',
    );
    expect(viteConfigSource).not.toContain(
      "OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify(controlUiBuildId)",
    );
    expect(serviceWorkerSource).not.toContain('const CACHE_NAME = "openclaw-control-v1"');
  });

  it("broadcasts updated versions to uncontrolled window clients during activation", async () => {
    const serviceWorkerSource = fs.readFileSync(serviceWorkerPath, "utf8");
    const windowClient = { postMessage: vi.fn() };
    const matchedClients = createDeferred<Array<typeof windowClient>>();
    const listeners = new Map<string, Array<(event: ActivateEventStub) => void>>();
    const cacheDelete = vi.fn(async () => true);
    const clients = {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(() => matchedClients.promise),
    };
    const caches = {
      delete: cacheDelete,
      keys: vi.fn(async () => [
        "openclaw-control-oldest",
        "openclaw-control-older",
        "openclaw-control-previous",
        "openclaw-control-new-build",
        "other-cache",
      ]),
      open: vi.fn(),
    };
    const serviceWorkerGlobal = {
      addEventListener(type: string, listener: (event: ActivateEventStub) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      clients,
      location: { href: "https://control.example/sw.js?v=new-build" },
      registration: { showNotification: vi.fn() },
      skipWaiting: vi.fn(),
    };
    const context = vm.createContext({
      URL,
      caches,
      fetch: vi.fn(),
      self: serviceWorkerGlobal,
    });

    new vm.Script(serviceWorkerSource, { filename: "ui/public/sw.js" }).runInContext(context);

    const activateHandler = listeners.get("activate")?.[0];
    expect(activateHandler).toBeDefined();
    let activationPromise: Promise<unknown> | undefined;
    activateHandler?.({
      waitUntil(promise: Promise<unknown>) {
        activationPromise = promise;
      },
    });

    let activationSettled = false;
    void activationPromise?.then(() => {
      activationSettled = true;
    });
    await Promise.resolve();

    expect(activationSettled).toBe(false);
    expect(windowClient.postMessage).not.toHaveBeenCalled();

    matchedClients.resolve([windowClient]);
    await activationPromise;

    expect(clients.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(clients.claim).toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledWith("openclaw-control-oldest");
    expect(windowClient.postMessage).toHaveBeenCalledWith({
      type: "sw-updated",
      version: "new-build",
    });
    expect(windowClient.postMessage.mock.calls[0]).toHaveLength(1);
  });
});

describe("Control UI service worker notification scope", () => {
  const rootScope = "https://control.example/";
  const nestedScope = "https://control.example/openclaw/";
  const nestedScopeWithoutSlash = "https://control.example/openclaw";

  function notificationScenario(
    name: string,
    scope: string,
    clientUrls: string[],
    options: {
      target?: string | null;
      focusedClientIndex?: number;
      navigatedUrl?: string;
      openedUrl?: string | null;
    } = {},
  ): NotificationClickScenario {
    return {
      name,
      scope,
      target: options.target ?? null,
      clientUrls,
      focusedClientIndex: options.focusedClientIndex ?? (clientUrls.length > 0 ? 0 : -1),
      ...(options.navigatedUrl === undefined ? {} : { navigatedUrl: options.navigatedUrl }),
      openedUrl:
        options.openedUrl === undefined
          ? clientUrls.length > 0
            ? null
            : scope
          : options.openedUrl,
    };
  }

  const scenarios: NotificationClickScenario[] = [
    notificationScenario(
      "focuses an existing root-scoped window for a title/body-only notification",
      rootScope,
      [rootScope],
    ),
    notificationScenario(
      "focuses an existing nested-scoped window for a title/body-only notification",
      nestedScope,
      [nestedScope],
    ),
    notificationScenario(
      "preserves a root window's fragment for a title/body-only notification",
      rootScope,
      [`${rootScope}#current-session`],
    ),
    notificationScenario(
      "preserves a root window's query and fragment for a title/body-only notification",
      rootScope,
      [`${rootScope}?session=42#current-session`],
    ),
    notificationScenario(
      "reuses a root-scoped child route for a title/body-only notification",
      rootScope,
      [`${rootScope}chat?session=42#current-session`],
    ),
    notificationScenario(
      "preserves a nested window's fragment for a title/body-only notification",
      nestedScope,
      [`${nestedScope}#current-session`],
    ),
    notificationScenario(
      "preserves a nested window's query and fragment for a title/body-only notification",
      nestedScope,
      [`${nestedScope}?session=42#current-session`],
    ),
    notificationScenario(
      "reuses a nested-scoped child route for a title/body-only notification",
      nestedScope,
      [`${nestedScope}chat?session=42#current-session`],
    ),
    notificationScenario(
      "focuses the exact slashless nested scope for a title/body-only notification",
      nestedScopeWithoutSlash,
      [nestedScopeWithoutSlash],
    ),
    notificationScenario(
      "preserves a slashless nested window's fragment for a title/body-only notification",
      nestedScopeWithoutSlash,
      [`${nestedScopeWithoutSlash}#current-session`],
    ),
    notificationScenario(
      "preserves a slashless nested window's query for a title/body-only notification",
      nestedScopeWithoutSlash,
      [`${nestedScopeWithoutSlash}?session=42#current-session`],
    ),
    notificationScenario(
      "reuses the canonical directory beneath a slashless nested scope",
      nestedScopeWithoutSlash,
      [`${nestedScopeWithoutSlash}/`],
    ),
    notificationScenario(
      "reuses a child route beneath a slashless nested scope",
      nestedScopeWithoutSlash,
      [`${nestedScopeWithoutSlash}/chat?session=42#current-session`],
    ),
    notificationScenario(
      "focuses the nested window instead of a competing same-origin root window",
      nestedScope,
      [rootScope, nestedScope],
      { focusedClientIndex: 1 },
    ),
    notificationScenario(
      "focuses the exact explicit nested route including its query and hash",
      nestedScope,
      [`${nestedScope}chat?session=42#latest`],
      { target: "chat?session=42#latest", navigatedUrl: `${nestedScope}chat?session=42#latest` },
    ),
    notificationScenario(
      "prefers a later exact explicit route over an unrelated nested app tab",
      nestedScope,
      [`${nestedScope}settings`, `${nestedScope}chat?session=42#latest`],
      {
        target: "chat?session=42#latest",
        focusedClientIndex: 1,
        navigatedUrl: `${nestedScope}chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "prefers a later exact route over a matching path and query with a stale fragment",
      nestedScope,
      [`${nestedScope}chat?session=42#previous`, `${nestedScope}chat?session=42#latest`],
      {
        target: "chat?session=42#latest",
        focusedClientIndex: 1,
        navigatedUrl: `${nestedScope}chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "prefers a matching path and query over an unrelated nested app tab",
      nestedScope,
      [`${nestedScope}settings`, `${nestedScope}chat?session=42`],
      {
        target: "chat?session=42#latest",
        focusedClientIndex: 1,
        navigatedUrl: `${nestedScope}chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "prefers a matching route over an unrelated nested app tab when its query is stale",
      nestedScope,
      [`${nestedScope}settings`, `${nestedScope}chat?session=7`],
      {
        target: "chat?session=42#latest",
        focusedClientIndex: 1,
        navigatedUrl: `${nestedScope}chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "prefers a later exact explicit route among root-scoped app tabs",
      rootScope,
      [`${rootScope}settings`, `${rootScope}chat?session=42#latest`],
      {
        target: "chat?session=42#latest",
        focusedClientIndex: 1,
        navigatedUrl: `${rootScope}chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "prefers a later exact explicit route beneath a slashless nested scope",
      nestedScopeWithoutSlash,
      [`${nestedScopeWithoutSlash}/settings`, `${nestedScopeWithoutSlash}/chat?session=42#latest`],
      {
        target: "chat?session=42#latest",
        focusedClientIndex: 1,
        navigatedUrl: `${nestedScopeWithoutSlash}/chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "restores a fragment omitted from the existing window client URL",
      nestedScope,
      [`${nestedScope}chat?session=42`],
      { target: "chat?session=42#latest", navigatedUrl: `${nestedScope}chat?session=42#latest` },
    ),
    notificationScenario(
      "resolves a relative route beneath a slashless nested scope",
      nestedScopeWithoutSlash,
      [`${nestedScopeWithoutSlash}/chat?session=42#latest`],
      {
        target: "chat?session=42#latest",
        navigatedUrl: `${nestedScopeWithoutSlash}/chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "restores an explicit fragment beneath a slashless nested scope",
      nestedScopeWithoutSlash,
      [`${nestedScopeWithoutSlash}/chat?session=42`],
      {
        target: "chat?session=42#latest",
        navigatedUrl: `${nestedScopeWithoutSlash}/chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "opens the relative target beneath a slashless nested scope",
      nestedScopeWithoutSlash,
      [],
      {
        target: "chat?session=42#latest",
        openedUrl: `${nestedScopeWithoutSlash}/chat?session=42#latest`,
      },
    ),
    notificationScenario(
      "navigates an explicit route instead of trusting stale SPA fragments",
      nestedScope,
      [`${nestedScope}chat?session=42#current-session`],
      { target: "chat?session=42", navigatedUrl: `${nestedScope}chat?session=42` },
    ),
    notificationScenario(
      "navigates a stale in-scope client to the exact explicit nested route",
      nestedScope,
      [`${nestedScope}chat?session=7#latest`],
      { target: "chat?session=42#latest", navigatedUrl: `${nestedScope}chat?session=42#latest` },
    ),
    notificationScenario("opens the canonical root scope when no window exists", rootScope, []),
    notificationScenario("opens the canonical nested scope when no window exists", nestedScope, []),
    notificationScenario(
      "opens the exact slashless nested scope when no window exists",
      nestedScopeWithoutSlash,
      [],
    ),
    notificationScenario(
      "never focuses a cross-origin window with the same nested pathname",
      nestedScope,
      ["https://outside.example/openclaw/"],
      { focusedClientIndex: -1, openedUrl: nestedScope },
    ),
    notificationScenario(
      "falls back to the registered scope for an explicit cross-origin target",
      nestedScope,
      [],
      { target: "https://outside.example/openclaw/chat" },
    ),
    notificationScenario(
      "rejects a sibling-prefix target and never focuses its window",
      nestedScope,
      ["https://control.example/openclaw-other/chat"],
      { target: "/openclaw-other/chat", focusedClientIndex: -1, openedUrl: nestedScope },
    ),
    notificationScenario(
      "rejects a sibling-prefix target for a slashless nested scope",
      nestedScopeWithoutSlash,
      ["https://control.example/openclaw-other/chat"],
      {
        target: "/openclaw-other/chat",
        focusedClientIndex: -1,
        openedUrl: nestedScopeWithoutSlash,
      },
    ),
    notificationScenario(
      "rejects ancestor traversal from a slashless nested scope",
      nestedScopeWithoutSlash,
      [rootScope],
      { target: "../", focusedClientIndex: -1, openedUrl: nestedScopeWithoutSlash },
    ),
    notificationScenario(
      "rejects a cross-origin target for a slashless nested scope",
      nestedScopeWithoutSlash,
      [],
      { target: "https://outside.example/openclaw/chat" },
    ),
    notificationScenario(
      "never focuses a sibling-prefix window for the default nested target",
      nestedScope,
      ["https://control.example/openclaw-other/"],
      { focusedClientIndex: -1, openedUrl: nestedScope },
    ),
    notificationScenario(
      "falls back to the registered scope for a malformed explicit target",
      nestedScope,
      [],
      { target: "https://[invalid" },
    ),
    notificationScenario(
      "rejects ancestor traversal without focusing the same-origin root window",
      nestedScope,
      [rootScope],
      { target: "../", focusedClientIndex: -1, openedUrl: nestedScope },
    ),
  ];

  it.each(scenarios)(
    "$name",
    async ({ scope, target, clientUrls, focusedClientIndex, navigatedUrl, openedUrl }) => {
      const worker = createNotificationServiceWorker(scope, clientUrls);
      const payload: ServiceWorkerPushPayload = {
        title: "OpenClaw",
        body: "Scoped notification",
      };
      if (target !== null) {
        payload.url = target;
      }

      const notification = await worker.dispatchPush(payload);

      expect(notification.title).toBe(payload.title);
      expect(notification.options.body).toBe(payload.body);
      expect(notification.options.data.url).toBe(target ?? scope);
      expect(notification.options.data.explicitUrl).toBe(target !== null);

      const close = await worker.dispatchNotificationClick(notification.options.data);

      expect(close).toHaveBeenCalledOnce();
      expect(worker.clients.matchAll).toHaveBeenCalledWith({
        type: "window",
        includeUncontrolled: true,
      });

      for (const [index, client] of worker.windowClients.entries()) {
        if (index === focusedClientIndex) {
          expect(client.focus).toHaveBeenCalledOnce();
        } else {
          expect(client.focus).not.toHaveBeenCalled();
        }
        if (index === focusedClientIndex && navigatedUrl) {
          expect(client.navigate).toHaveBeenCalledExactlyOnceWith(navigatedUrl);
        } else {
          expect(client.navigate).not.toHaveBeenCalled();
        }
      }

      if (openedUrl === null) {
        expect(worker.clients.openWindow).not.toHaveBeenCalled();
      } else {
        expect(worker.clients.openWindow).toHaveBeenCalledExactlyOnceWith(openedUrl);
      }
    },
  );

  it.each([
    {
      name: "root",
      scope: rootScope,
      clientUrl: `${rootScope}?session=42#current-session`,
    },
    {
      name: "nested",
      scope: nestedScope,
      clientUrl: `${nestedScope}?session=42#current-session`,
    },
    {
      name: "slashless nested",
      scope: nestedScopeWithoutSlash,
      clientUrl: `${nestedScopeWithoutSlash}?session=42#current-session`,
    },
    {
      name: "root child route",
      scope: rootScope,
      clientUrl: `${rootScope}chat?session=42#current-session`,
    },
    {
      name: "nested child route",
      scope: nestedScope,
      clientUrl: `${nestedScope}chat?session=42#current-session`,
    },
    {
      name: "slashless nested child route",
      scope: nestedScopeWithoutSlash,
      clientUrl: `${nestedScopeWithoutSlash}/chat?session=42#current-session`,
    },
  ])(
    "preserves a $name query-state tab for a previous worker's default notification",
    async ({ scope, clientUrl }) => {
      const worker = createNotificationServiceWorker(scope, [clientUrl]);

      const close = await worker.dispatchNotificationClick({ url: "./" });

      expect(close).toHaveBeenCalledOnce();
      expect(worker.clients.matchAll).toHaveBeenCalledWith({
        type: "window",
        includeUncontrolled: true,
      });
      expect(worker.windowClients[0]?.focus).toHaveBeenCalledOnce();
      expect(worker.windowClients[0]?.navigate).not.toHaveBeenCalled();
      expect(worker.clients.openWindow).not.toHaveBeenCalled();
    },
  );

  it("navigates a previous worker's explicit notification to its exact target", async () => {
    const worker = createNotificationServiceWorker(nestedScope, [`${nestedScope}chat?session=7`]);

    const close = await worker.dispatchNotificationClick({ url: "chat?session=42" });

    expect(close).toHaveBeenCalledOnce();
    expect(worker.windowClients[0]?.focus).toHaveBeenCalledOnce();
    expect(worker.windowClients[0]?.navigate).toHaveBeenCalledExactlyOnceWith(
      `${nestedScope}chat?session=42`,
    );
    expect(worker.clients.openWindow).not.toHaveBeenCalled();
  });

  it("prefers the matching tab for a previous worker's explicit notification", async () => {
    const target = `${nestedScope}chat?session=42`;
    const worker = createNotificationServiceWorker(nestedScope, [`${nestedScope}settings`, target]);

    const close = await worker.dispatchNotificationClick({ url: "chat?session=42" });

    expect(close).toHaveBeenCalledOnce();
    expect(worker.windowClients[0]?.navigate).not.toHaveBeenCalled();
    expect(worker.windowClients[0]?.focus).not.toHaveBeenCalled();
    expect(worker.windowClients[1]?.navigate).toHaveBeenCalledExactlyOnceWith(target);
    expect(worker.windowClients[1]?.focus).toHaveBeenCalledOnce();
    expect(worker.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens the exact target when a previous worker rejects client navigation", async () => {
    const worker = createNotificationServiceWorker(nestedScope, [`${nestedScope}chat?session=7`], {
      rejectNavigation: true,
    });

    const close = await worker.dispatchNotificationClick({ url: "chat?session=42#latest" });

    expect(close).toHaveBeenCalledOnce();
    expect(worker.windowClients[0]?.navigate).toHaveBeenCalledExactlyOnceWith(
      `${nestedScope}chat?session=42#latest`,
    );
    expect(worker.windowClients[0]?.focus).not.toHaveBeenCalled();
    expect(worker.clients.openWindow).toHaveBeenCalledExactlyOnceWith(
      `${nestedScope}chat?session=42#latest`,
    );
  });
});

type ActivateEventStub = {
  waitUntil(promise: Promise<unknown>): void;
};

type NotificationClickScenario = {
  name: string;
  scope: string;
  target: string | null;
  clientUrls: string[];
  focusedClientIndex: number;
  navigatedUrl?: string;
  openedUrl: string | null;
};

type ServiceWorkerPushPayload = {
  title: string;
  body: string;
  url?: string;
};

type ServiceWorkerNotificationOptions = {
  body: string;
  icon: string;
  badge: string;
  tag: string;
  data: { url: string; explicitUrl: boolean };
};

type ServiceWorkerNotificationEventStub = {
  data?: {
    json(): ServiceWorkerPushPayload;
    text(): string;
  };
  notification?: {
    close(): void;
    data: { url: string; explicitUrl?: boolean };
  };
  waitUntil(promise: Promise<unknown>): void;
};

function createNotificationServiceWorker(
  scope: string,
  clientUrls: string[],
  options: { rejectNavigation?: boolean } = {},
) {
  const listeners = new Map<string, (event: ServiceWorkerNotificationEventStub) => void>();
  const windowClients = clientUrls.map((url) => {
    const focus = vi.fn(async () => undefined);
    return {
      url,
      focus,
      navigate: vi.fn(async (_url: string) => {
        if (options.rejectNavigation) {
          throw new Error("Window is controlled by a previous service worker");
        }
        return { focus };
      }),
    };
  });
  const clients = {
    matchAll: vi.fn(async () => windowClients),
    openWindow: vi.fn(async (_url: string) => null),
  };
  const showNotification = vi.fn(
    async (_title: string, _options: ServiceWorkerNotificationOptions) => undefined,
  );
  const scopeUrl = new URL(scope);
  const serviceWorkerGlobal = {
    addEventListener(type: string, listener: (event: ServiceWorkerNotificationEventStub) => void) {
      listeners.set(type, listener);
    },
    clients,
    location: {
      href: new URL("sw.js?v=notification-scope", scopeUrl).href,
      origin: scopeUrl.origin,
    },
    registration: { scope, showNotification },
    skipWaiting: vi.fn(),
  };
  const context = vm.createContext({
    URL,
    caches: {},
    fetch: vi.fn(),
    self: serviceWorkerGlobal,
  });

  new vm.Script(fs.readFileSync(serviceWorkerPath, "utf8"), {
    filename: "ui/public/sw.js",
  }).runInContext(context);

  return {
    clients,
    windowClients,
    async dispatchPush(payload: ServiceWorkerPushPayload) {
      const listener = listeners.get("push");
      if (!listener) {
        throw new Error("Service worker did not register a push handler");
      }

      let completion: Promise<unknown> | undefined;
      listener({
        data: {
          json: () => payload,
          text: () => payload.body,
        },
        waitUntil(promise) {
          completion = promise;
        },
      });

      if (!completion) {
        throw new Error("Service worker push did not register a completion promise");
      }
      await completion;

      const notification = showNotification.mock.calls.at(-1);
      if (!notification) {
        throw new Error("Service worker push did not show a notification");
      }

      return { title: notification[0], options: notification[1] };
    },
    async dispatchNotificationClick(data: { url: string; explicitUrl?: boolean }) {
      const listener = listeners.get("notificationclick");
      if (!listener) {
        throw new Error("Service worker did not register a notification-click handler");
      }

      const close = vi.fn();
      let completion: Promise<unknown> | undefined;
      listener({
        notification: { close, data },
        waitUntil(promise) {
          completion = promise;
        },
      });

      if (!completion) {
        throw new Error("Notification click did not register a completion promise");
      }
      await completion;
      return close;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
