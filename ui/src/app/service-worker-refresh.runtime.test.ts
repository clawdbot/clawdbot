/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("Control UI service-worker reconnect refresh", () => {
  it("keeps the reconnect fence pending while a replacement worker installs", async () => {
    let state: ServiceWorkerState = "installing";
    const listeners = new Set<() => void>();
    const replacement = {
      get state() {
        return state;
      },
      addEventListener(_type: "statechange", listener: () => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: "statechange", listener: () => void) {
        listeners.delete(listener);
      },
    } as unknown as ServiceWorker;
    const registration: {
      active: ServiceWorker | null;
      installing: ServiceWorker | null;
      waiting: ServiceWorker | null;
      update: () => Promise<void>;
    } = {
      active: {} as ServiceWorker,
      installing: null,
      waiting: null,
      update: vi.fn(async () => {
        registration.installing = replacement;
      }),
    };
    const serviceWorker = {
      getRegistration: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    } as unknown as ServiceWorkerContainer;
    vi.stubGlobal("navigator", { serviceWorker });

    const { refreshWorker } = await import("./sw-refresh.runtime.ts");
    const host = { refreshPending: true };
    refreshWorker(host, { snapshot: { phase: "connected" } });
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.refreshPending).toBe(true);
    state = "activated";
    for (const listener of listeners) {
      listener();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(host.refreshPending).toBe(true);
  });

  it("releases the reconnect fence when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { refreshWorker } = await import("./sw-refresh.runtime.ts");
    const host = { refreshPending: true };

    refreshWorker(host, { snapshot: { phase: "connected" } });
    await vi.waitFor(() => expect(host.refreshPending).toBe(false));
  });
});
