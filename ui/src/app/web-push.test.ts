/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";
import { createWebPushCapability } from "./web-push.ts";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "serviceWorker",
);

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

function gatewayHarness() {
  let snapshot = {
    phase: "connecting",
    client: null,
  } as unknown as ApplicationGatewaySnapshot;
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    connect(client: GatewayBrowserClient) {
      snapshot = { ...snapshot, phase: "connected", client };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function gatewayClient(vapidPublicKey: Promise<string>) {
  const request = vi.fn(async (method: string) => {
    if (method === "push.web.vapidPublicKey") {
      return { vapidPublicKey: await vapidPublicKey };
    }
    if (method === "push.web.subscribe") {
      return { subscriptionId: "subscription-1" };
    }
    return { removed: true };
  });
  return { client: { request } as unknown as GatewayBrowserClient, request };
}

describe("web push Gateway reconciliation", () => {
  beforeEach(() => {
    const subscription = existingSubscription([4, 1, 2, 3]);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
        }),
      },
    });
    vi.stubGlobal("PushManager", vi.fn());
    vi.stubGlobal("Notification", { permission: "granted" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalServiceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("ignores stale reconciliation after switching Gateways", async () => {
    const firstKey = createDeferred<string>();
    const secondKey = createDeferred<string>();
    const first = gatewayClient(firstKey.promise);
    const second = gatewayClient(secondKey.promise);
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);

    harness.connect(first.client);
    harness.connect(second.client);
    await vi.waitFor(() => {
      expect(first.request).toHaveBeenCalledWith("push.web.vapidPublicKey", {});
      expect(second.request).toHaveBeenCalledWith("push.web.vapidPublicKey", {});
    });

    secondKey.resolve(encodedVapidKey([4, 9, 8, 7]));
    await vi.waitFor(() => expect(capability.snapshot.error).toContain("another Gateway"));
    expect(capability.snapshot.subscribed).toBe(true);

    firstKey.resolve(encodedVapidKey([4, 1, 2, 3]));
    await vi.waitFor(() =>
      expect(first.request).toHaveBeenCalledWith(
        "push.web.subscribe",
        expect.objectContaining({ endpoint: "https://push.example.test/subscription" }),
      ),
    );
    expect(capability.snapshot.error).toContain("another Gateway");
    expect(capability.snapshot.subscribed).toBe(true);
    capability.dispose();
  });
});
