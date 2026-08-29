/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { getExistingSubscription, subscribeToWebPush } from "./web-push.runtime.ts";

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

function encodedVapidKey(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64url");
}

function existingSubscription(vapidBytes: number[]): PushSubscription {
  return {
    endpoint: "https://push.example.test/subscription",
    options: {
      applicationServerKey: Uint8Array.from(vapidBytes).buffer,
      userVisibleOnly: true,
    },
    toJSON: () => ({
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "p256dh", auth: "auth" },
    }),
  } as unknown as PushSubscription;
}

function gatewayClient(vapidBytes: number[]) {
  const request = vi.fn(async (method: string) => {
    if (method === "push.web.vapidPublicKey") {
      return { vapidPublicKey: encodedVapidKey(vapidBytes) };
    }
    if (method === "push.web.subscribe") {
      return { subscriptionId: "subscription-1" };
    }
    return { removed: true };
  });
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalServiceWorkerDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

describe("web push service worker readiness", () => {
  it("treats a registration without PushManager as unsupported instead of throwing", async () => {
    installServiceWorkerReady(Promise.resolve({} as ServiceWorkerRegistration));
    await expect(getExistingSubscription()).resolves.toBeNull();
  });

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

describe("web push Gateway identity", () => {
  it("reuses one browser subscription for Gateways that share its VAPID key", async () => {
    const subscription = existingSubscription([4, 1, 2, 3]);
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    const subscribe = vi
      .fn()
      .mockRejectedValue(new DOMException("Options differ", "InvalidStateError"));
    installServiceWorkerReady(
      Promise.resolve({
        pushManager: { getSubscription, subscribe },
      } as unknown as ServiceWorkerRegistration),
    );
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") });
    const { client, request } = gatewayClient([4, 1, 2, 3]);

    await expect(subscribeToWebPush(client)).resolves.toEqual({
      state: "registered",
    });
    expect(request).toHaveBeenNthCalledWith(1, "push.web.vapidPublicKey", {});
    expect(request).toHaveBeenNthCalledWith(2, "push.web.subscribe", {
      endpoint: subscription.endpoint,
      keys: { p256dh: "p256dh", auth: "auth" },
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("rejects a different Gateway key without deactivating the owning subscription", async () => {
    const subscription = existingSubscription([4, 1, 2, 3]);
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    const subscribe = vi
      .fn()
      .mockRejectedValue(new DOMException("Options differ", "InvalidStateError"));
    installServiceWorkerReady(
      Promise.resolve({
        pushManager: { getSubscription, subscribe },
      } as unknown as ServiceWorkerRegistration),
    );
    vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("granted") });
    const { client, request } = gatewayClient([4, 9, 8, 7]);

    await expect(subscribeToWebPush(client)).resolves.toEqual({
      state: "vapid-mismatch",
      error: expect.stringContaining("belongs to another Gateway"),
    });
    expect(request).toHaveBeenNthCalledWith(2, "push.web.unsubscribe", {
      endpoint: subscription.endpoint,
    });
    expect(request).not.toHaveBeenCalledWith("push.web.subscribe", expect.anything());
    expect(subscribe).not.toHaveBeenCalled();
  });
});
