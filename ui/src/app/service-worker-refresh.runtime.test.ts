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

    const { refreshControlUiServiceWorker } = await import("./sw-refresh.runtime.ts");
    let settled = false;
    const refresh = refreshControlUiServiceWorker().then((replacementActivated) => {
      settled = true;
      return replacementActivated;
    });
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce());
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(settled).toBe(false);
    state = "activated";
    for (const listener of listeners) {
      listener();
    }
    await expect(refresh).resolves.toBe(true);
  });

  it("joins an already-installing replacement without starting a competing update", async () => {
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
    const update = vi.fn(async () => {
      throw new Error("must not compete with the active install");
    });
    const registration = {
      active: {} as ServiceWorker,
      installing: replacement,
      waiting: null,
      update,
    } as unknown as ServiceWorkerRegistration;
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: registration.active,
        getRegistration: vi.fn(async () => registration),
      },
    });

    const { refreshControlUiServiceWorker } = await import("./sw-refresh.runtime.ts");
    const refresh = refreshControlUiServiceWorker();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(update).not.toHaveBeenCalled();

    state = "activated";
    for (const listener of listeners) {
      listener();
    }
    await expect(refresh).resolves.toBe(true);
  });

  it("releases the reconnect fence when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { refreshControlUiServiceWorker } = await import("./sw-refresh.runtime.ts");

    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
  });
});
