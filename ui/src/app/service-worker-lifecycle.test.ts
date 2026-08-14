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
    const registration = {
      active: {} as ServiceWorker,
      installing: null as ServiceWorker | null,
      waiting: null as ServiceWorker | null,
      update: vi.fn(async () => {
        registration.installing = replacement;
      }),
    } as unknown as ServiceWorkerRegistration;
    const serviceWorker = {
      addEventListener: vi.fn(),
      register: vi.fn(async () => registration),
    } as unknown as ServiceWorkerContainer;
    vi.stubGlobal("navigator", { serviceWorker });

    const { installControlUiServiceWorker, refreshControlUiServiceWorker } =
      await import("./service-worker-lifecycle.ts");
    installControlUiServiceWorker(true);
    await Promise.resolve();

    let settled = false;
    const refresh = refreshControlUiServiceWorker().then((replacementActivated) => {
      settled = true;
      return replacementActivated;
    });
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    state = "activated";
    for (const listener of listeners) {
      listener();
    }
    await expect(refresh).resolves.toBe(true);
  });

  it("releases the reconnect fence when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { refreshControlUiServiceWorker } = await import("./service-worker-lifecycle.ts");

    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
  });
});
