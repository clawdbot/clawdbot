/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getExistingSubscription } from "./web-push.runtime.ts";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "serviceWorker",
);

function installServiceWorkerReady(ready: Promise<ServiceWorkerRegistration>): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready },
  });
}

afterEach(() => {
  vi.useRealTimers();
  if (originalServiceWorkerDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

describe("web push service worker readiness", () => {
  it("clears the readiness timeout when the service worker is already ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const registration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
      },
    } as unknown as ServiceWorkerRegistration;
    installServiceWorkerReady(Promise.resolve(registration));

    for (let i = 0; i < 3; i += 1) {
      await expect(getExistingSubscription()).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("still rejects when service worker readiness times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installServiceWorkerReady(new Promise<ServiceWorkerRegistration>(() => {}));

    const subscription = getExistingSubscription();
    const rejection = expect(subscription).rejects.toThrow("Service worker not ready (timed out)");
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
