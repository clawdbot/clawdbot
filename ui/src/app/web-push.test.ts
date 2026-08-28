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
const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, "userAgent");
const originalMaxTouchPointsDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "maxTouchPoints",
);
const originalStandaloneDescriptor = Object.getOwnPropertyDescriptor(navigator, "standalone");
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");

function setNavigatorValue(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, { configurable: true, value });
}

function restoreNavigatorValue(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(navigator, key, descriptor);
  } else {
    Reflect.deleteProperty(navigator, key);
  }
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
    restoreNavigatorValue("userAgent", originalUserAgentDescriptor);
    restoreNavigatorValue("maxTouchPoints", originalMaxTouchPointsDescriptor);
    restoreNavigatorValue("standalone", originalStandaloneDescriptor);
    restoreNavigatorValue("platform", originalPlatformDescriptor);
    if (originalServiceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it.each([
    ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 1, ""],
    ["iPad", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", 5, ""],
    [
      "desktop-mode iPad",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15",
      5,
      "MacIntel",
    ],
  ])(
    "requires Home Screen installation on %s Safari",
    async (_label, userAgent, maxTouchPoints, platform) => {
      setNavigatorValue("userAgent", userAgent);
      setNavigatorValue("maxTouchPoints", maxTouchPoints);
      setNavigatorValue("standalone", false);
      setNavigatorValue("platform", platform);

      const capability = createWebPushCapability(gatewayHarness().gateway);

      await vi.waitFor(() =>
        expect(capability.snapshot).toMatchObject({
          supported: false,
          permission: "install-required",
        }),
      );
      capability.dispose();
    },
  );

  it("requires Home Screen installation before Web Push APIs are exposed", async () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    setNavigatorValue("standalone", false);
    Reflect.deleteProperty(navigator, "serviceWorker");
    Reflect.deleteProperty(globalThis, "PushManager");
    Reflect.deleteProperty(globalThis, "Notification");

    const capability = createWebPushCapability(gatewayHarness().gateway);

    await vi.waitFor(() =>
      expect(capability.snapshot).toMatchObject({
        supported: false,
        permission: "install-required",
      }),
    );
    capability.dispose();
  });

  it("enables Web Push for an installed iOS PWA", async () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    setNavigatorValue("maxTouchPoints", 5);
    setNavigatorValue("standalone", true);
    setNavigatorValue("platform", "MacIntel");

    const capability = createWebPushCapability(gatewayHarness().gateway);

    await vi.waitFor(() =>
      expect(capability.snapshot).toMatchObject({
        supported: true,
        permission: "granted",
      }),
    );
    capability.dispose();
  });

  it("ignores stale reconciliation after switching Gateways", async () => {
    const firstKey = createDeferred<string>();
    const secondKey = createDeferred<string>();
    const first = gatewayClient(firstKey.promise);
    const second = gatewayClient(secondKey.promise);
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);

    harness.connect(first.client);
    await vi.waitFor(() => {
      expect(first.request).toHaveBeenCalledWith("push.web.vapidPublicKey", {});
    });
    harness.connect(second.client);
    await vi.waitFor(() => {
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
