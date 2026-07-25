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

type ActivateEventStub = {
  waitUntil(promise: Promise<unknown>): void;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
