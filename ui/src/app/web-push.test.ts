/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPushNotificationPreferences } from "../../../packages/gateway-protocol/src/schema/push.ts";
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
  const eventListeners = new Set<Parameters<ApplicationGateway["subscribeEvents"]>[0]>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener: Parameters<ApplicationGateway["subscribeEvents"]>[0]) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    connect(client: GatewayBrowserClient, profileId = "profile-owner") {
      snapshot = {
        ...snapshot,
        phase: "connected",
        client,
        selfUser: { id: profileId },
      } as unknown as ApplicationGatewaySnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    emit(event: Parameters<Parameters<ApplicationGateway["subscribeEvents"]>[0]>[0]) {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
  };
}

function notificationPreferences(approvalRequested: boolean): WebPushNotificationPreferences {
  return {
    categories: {
      approvalRequested,
      agentFinished: false,
      agentQuestion: false,
      scheduledTaskFailed: false,
      backgroundTaskFailed: false,
    },
    detailLevel: "private",
    quietHours: { enabled: false, startMinute: 1_320, endMinute: 420, timeZone: "UTC" },
    agentIds: [],
  };
}

function preferenceResult(user: WebPushNotificationPreferences) {
  return {
    durableIdentity: true,
    user,
    device: { enabled: true, label: "" },
    effective: { ...user, enabled: true, label: "" },
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

  it("publishes ordinary browser support synchronously for the first-send prompt", () => {
    const capability = createWebPushCapability(gatewayHarness().gateway);

    expect(capability.snapshot).toMatchObject({ supported: true, permission: "granted" });
    capability.dispose();
  });

  it("keeps subscribers independent when an older listener unsubscribes", async () => {
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = capability.subscribe(first);
    capability.subscribe(second);

    stopFirst();
    harness.connect(gatewayClient(Promise.resolve(encodedVapidKey([4, 1, 2, 3]))).client);
    await vi.waitFor(() => expect(second).toHaveBeenCalled());

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    capability.dispose();
  });

  it("serializes rapid preference edits without dropping the latest full object", async () => {
    const firstSave = createDeferred();
    const first = notificationPreferences(true);
    const second = notificationPreferences(false);
    let stored = first;
    let saveCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(stored);
      }
      if (method === "push.web.preferences.set") {
        saveCount += 1;
        if (saveCount === 1) {
          await firstSave.promise;
        }
        stored = (params as { preferences: WebPushNotificationPreferences }).preferences;
        return { scope: "user", preferences: stored };
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    harness.connect({ request } as unknown as GatewayBrowserClient);
    await vi.waitFor(() => expect(capability.snapshot.preferences).toBeTruthy());
    request.mockClear();

    const firstOperation = capability.run({ kind: "set", scope: "user", preferences: first });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "push.web.preferences.set",
        expect.objectContaining({ preferences: first }),
      ),
    );
    const secondOperation = capability.run({ kind: "set", scope: "user", preferences: second });
    firstSave.resolve();

    await Promise.all([firstOperation, secondOperation]);
    expect(request.mock.calls.filter(([method]) => method === "push.web.preferences.set")).toEqual([
      ["push.web.preferences.set", expect.objectContaining({ preferences: first })],
      ["push.web.preferences.set", expect.objectContaining({ preferences: second })],
    ]);
    expect(capability.snapshot.preferences?.user).toEqual(second);
    capability.dispose();
  });

  it("refreshes matching defaults without publishing a stale invalidation", async () => {
    const initial = notificationPreferences(true);
    const stale = { ...notificationPreferences(true), detailLevel: "detailed" as const };
    const latest = notificationPreferences(false);
    const firstRefresh = createDeferred<ReturnType<typeof preferenceResult>>();
    let preferenceRead = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        preferenceRead += 1;
        if (preferenceRead === 1) {
          return preferenceResult(initial);
        }
        if (preferenceRead === 2) {
          return await firstRefresh.promise;
        }
        return preferenceResult(latest);
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    harness.connect({ request } as unknown as GatewayBrowserClient, "profile-owner");
    await vi.waitFor(() => expect(capability.snapshot.preferences?.user).toEqual(initial));

    harness.emit({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "other-profile", keys: ["notifications.web.v1"] },
    });
    expect(preferenceRead).toBe(1);

    const invalidation = {
      type: "event" as const,
      event: "users.prefs.changed",
      payload: { profileId: "profile-owner", keys: ["notifications.web.v1"] },
    };
    harness.emit(invalidation);
    await vi.waitFor(() => expect(preferenceRead).toBe(2));
    harness.emit(invalidation);
    await vi.waitFor(() => expect(capability.snapshot.preferences?.user).toEqual(latest));
    firstRefresh.resolve(preferenceResult(stale));
    await Promise.resolve();

    expect(capability.snapshot.preferences?.user).toEqual(latest);
    capability.dispose();
  });

  it("reruns full reconciliation when preferences change during initial connection", async () => {
    const firstKey = createDeferred<string>();
    let vapidRead = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        vapidRead += 1;
        return {
          vapidPublicKey: vapidRead === 1 ? await firstKey.promise : encodedVapidKey([4, 1, 2, 3]),
        };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(notificationPreferences(false));
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    harness.connect({ request } as unknown as GatewayBrowserClient, "profile-owner");
    await vi.waitFor(() => expect(vapidRead).toBe(1));

    harness.emit({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "profile-owner", keys: ["notifications.web.v1"] },
    });

    await vi.waitFor(() => expect(vapidRead).toBe(2));
    await vi.waitFor(() =>
      expect(capability.snapshot.preferences?.user).toEqual(notificationPreferences(false)),
    );
    firstKey.resolve(encodedVapidKey([4, 9, 8, 7]));
    await Promise.resolve();
    expect(capability.snapshot.error).toBeNull();
    capability.dispose();
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

  it("requires Home Screen installation in an iPhone browser shell without standalone", () => {
    setNavigatorValue("userAgent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    Reflect.deleteProperty(navigator, "standalone");

    const capability = createWebPushCapability(gatewayHarness().gateway);

    expect(capability.snapshot).toMatchObject({
      supported: false,
      permission: "install-required",
    });
    capability.dispose();
  });

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
