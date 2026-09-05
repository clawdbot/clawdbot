/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

function createReplacementWorker() {
  let state: ServiceWorkerState = "installing";
  const listeners = new Set<() => void>();
  const worker = {
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
  return {
    worker,
    activate() {
      state = "activated";
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/** Mirrors `ui/public/sw.js`: the activating worker announces the build it
 * serves, then reports `activated`. */
function createServiceWorkerContainer(
  registration: ServiceWorkerRegistration,
  controller: ServiceWorker | null,
) {
  const messageListeners = new Set<(event: MessageEvent) => void>();
  return {
    container: {
      controller,
      getRegistration: vi.fn(async () => registration),
      addEventListener: (_type: "message", listener: (event: MessageEvent) => void) => {
        messageListeners.add(listener);
      },
      removeEventListener: (_type: "message", listener: (event: MessageEvent) => void) => {
        messageListeners.delete(listener);
      },
    } as unknown as ServiceWorkerContainer,
    announce(version: string) {
      for (const listener of messageListeners) {
        listener({ data: { type: "sw-updated", version } } as MessageEvent);
      }
    },
  };
}

describe("Control UI service-worker reconnect refresh", () => {
  it("keeps the reconnect fence pending while a replacement worker installs", async () => {
    const replacement = createReplacementWorker();
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
        registration.installing = replacement.worker;
      }),
    };
    const serviceWorker = createServiceWorkerContainer(
      registration as unknown as ServiceWorkerRegistration,
      null,
    );
    vi.stubGlobal("navigator", { serviceWorker: serviceWorker.container });

    const { refreshControlUiServiceWorker } = await import("./sw-refresh.runtime.ts");
    let settled = false;
    const refresh = refreshControlUiServiceWorker().then((documentRetired) => {
      settled = true;
      return documentRetired;
    });
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce());
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(settled).toBe(false);
    serviceWorker.announce("next-build");
    replacement.activate();
    await expect(refresh).resolves.toBe(true);
  });

  it("joins an already-installing replacement without starting a competing update", async () => {
    const replacement = createReplacementWorker();
    const update = vi.fn(async () => {
      throw new Error("must not compete with the active install");
    });
    const registration = {
      active: {} as ServiceWorker,
      installing: replacement.worker,
      waiting: null,
      update,
    } as unknown as ServiceWorkerRegistration;
    const serviceWorker = createServiceWorkerContainer(registration, registration.active);
    vi.stubGlobal("navigator", { serviceWorker: serviceWorker.container });

    const { refreshControlUiServiceWorker } = await import("./sw-refresh.runtime.ts");
    const refresh = refreshControlUiServiceWorker();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(update).not.toHaveBeenCalled();

    serviceWorker.announce("next-build");
    replacement.activate();
    await expect(refresh).resolves.toBe(true);
  });

  it("releases the reconnect fence when the replacement serves this document's build", async () => {
    // The document already reloaded onto the new bundle while its worker was
    // still installing. That worker activating reloads nothing, so callers
    // holding work back for a reload would wait for one that never comes.
    const replacement = createReplacementWorker();
    const registration = {
      active: {} as ServiceWorker,
      installing: replacement.worker,
      waiting: null,
      update: vi.fn(),
    } as unknown as ServiceWorkerRegistration;
    const serviceWorker = createServiceWorkerContainer(registration, registration.active);
    vi.stubGlobal("navigator", { serviceWorker: serviceWorker.container });

    const [{ refreshControlUiServiceWorker }, { CONTROL_UI_BUILD_INFO }] = await Promise.all([
      import("./sw-refresh.runtime.ts"),
      import("../build-info.ts"),
    ]);
    const refresh = refreshControlUiServiceWorker();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    serviceWorker.announce(CONTROL_UI_BUILD_INFO.buildId);
    replacement.activate();

    await expect(refresh).resolves.toBe(false);
  });

  it("releases the reconnect fence when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { refreshControlUiServiceWorker } = await import("./sw-refresh.runtime.ts");

    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
  });
});
