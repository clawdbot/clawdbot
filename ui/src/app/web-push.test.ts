/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPushNotificationPreferences } from "../../../packages/gateway-protocol/src/schema/push.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { renderNotificationsSection } from "../pages/config/notifications-section.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
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
      humanMentioned: false,
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
    const registration = {
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
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

  it("makes actions unavailable when the lazy runtime fails to load", async () => {
    vi.resetModules();
    vi.doMock("./web-push.runtime.ts", () => {
      throw new Error("Web Push runtime unavailable");
    });
    const { createWebPushCapability: createCapabilityWithFailedRuntime } =
      await import("./web-push.ts");

    const capability = createCapabilityWithFailedRuntime(gatewayHarness().gateway);
    try {
      await vi.waitFor(() =>
        expect(capability.snapshot).toMatchObject({
          supported: false,
          permission: "unsupported",
          subscription: "unknown",
          error: expect.stringContaining("Web Push runtime unavailable"),
        }),
      );
      await capability.run({ kind: "enable" });

      expect(capability.snapshot.loading).toBe(false);
    } finally {
      capability.dispose();
      vi.doUnmock("./web-push.runtime.ts");
      vi.resetModules();
    }
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

  it("schedules initial reconciliation through the connection bootstrap coordinator", async () => {
    const coordinatorRuns: string[] = [];
    const coordinator = {
      reset: () => {},
      run: async (key, task) => {
        coordinatorRuns.push(key);
        await task();
      },
      synchronize: () => {},
    } satisfies ConnectionBootstrapCoordinator;
    const harness = gatewayHarness();
    const connection = gatewayClient(Promise.resolve(encodedVapidKey([4, 1, 2, 3])));
    const capability = createWebPushCapability(harness.gateway, {
      connectionBootstrap: coordinator,
    });

    harness.connect(connection.client);
    await vi.waitFor(() => expect(coordinatorRuns).toEqual(["web-push-reconcile"]));
    await vi.waitFor(() =>
      expect(connection.request).toHaveBeenCalledWith(
        "push.web.subscribe",
        expect.objectContaining({ endpoint: "https://push.example.test/subscription" }),
      ),
    );

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
    expect(capability.snapshot).toMatchObject({ subscription: "unknown", preferences: null });
    await vi.waitFor(() => {
      expect(second.request).toHaveBeenCalledWith("push.web.vapidPublicKey", {});
    });

    secondKey.resolve(encodedVapidKey([4, 9, 8, 7]));
    await vi.waitFor(() => expect(capability.snapshot.error).toContain("another Gateway"));
    expect(capability.snapshot.subscription).toBe("vapid-mismatch");

    firstKey.resolve(encodedVapidKey([4, 1, 2, 3]));
    await vi.waitFor(() =>
      expect(first.request).toHaveBeenCalledWith(
        "push.web.subscribe",
        expect.objectContaining({ endpoint: "https://push.example.test/subscription" }),
      ),
    );
    expect(capability.snapshot.error).toContain("another Gateway");
    expect(capability.snapshot.subscription).toBe("vapid-mismatch");
    capability.dispose();
  });

  it("ignores a stale preference action after switching Gateways", async () => {
    const firstSave = createDeferred();
    const stalePreferences = notificationPreferences(true);
    const currentPreferences = notificationPreferences(false);
    const firstRequest = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.set") {
        await firstSave.promise;
        return { scope: "user", preferences: stalePreferences };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(stalePreferences);
      }
      return {};
    });
    const secondRequest = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(currentPreferences);
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    harness.connect({ request: firstRequest } as unknown as GatewayBrowserClient);
    await vi.waitFor(() => expect(capability.snapshot.preferences?.user).toEqual(stalePreferences));

    const action = capability.run({
      kind: "set",
      scope: "user",
      preferences: stalePreferences,
    });
    await vi.waitFor(() =>
      expect(firstRequest).toHaveBeenCalledWith(
        "push.web.preferences.set",
        expect.objectContaining({ preferences: stalePreferences }),
      ),
    );
    harness.connect({ request: secondRequest } as unknown as GatewayBrowserClient);
    await vi.waitFor(() =>
      expect(capability.snapshot.preferences?.user).toEqual(currentPreferences),
    );

    firstSave.resolve();
    await action;

    expect(capability.snapshot.preferences?.user).toEqual(currentPreferences);
    expect(capability.snapshot.error).toBeNull();
    capability.dispose();
  });

  it("keeps the current Gateway error when a queued stale action begins", async () => {
    const firstSave = createDeferred();
    const preferences = notificationPreferences(true);
    let saveCount = 0;
    const firstRequest = vi.fn(async (method: string) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.subscribe") {
        return { subscriptionId: "subscription-1" };
      }
      if (method === "push.web.preferences.set") {
        saveCount += 1;
        if (saveCount === 1) {
          await firstSave.promise;
        }
        return { scope: "user", preferences };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(preferences);
      }
      return {};
    });
    const second = gatewayClient(Promise.resolve(encodedVapidKey([4, 9, 8, 7])));
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    harness.connect({ request: firstRequest } as unknown as GatewayBrowserClient);
    await vi.waitFor(() => expect(capability.snapshot.preferences).toBeTruthy());

    const firstAction = capability.run({ kind: "set", scope: "user", preferences });
    await vi.waitFor(() => expect(saveCount).toBe(1));
    const queuedAction = capability.run({ kind: "set", scope: "user", preferences });
    await Promise.resolve();
    harness.connect(second.client);
    await vi.waitFor(() => expect(capability.snapshot.error).toContain("another Gateway"));

    firstSave.resolve();
    await Promise.all([firstAction, queuedAction]);

    expect(capability.snapshot.error).toContain("another Gateway");
    expect(capability.snapshot.subscription).toBe("vapid-mismatch");
    capability.dispose();
  });

  it.each(["reconnect", "enable"] as const)(
    "resets a mismatched browser subscription detected during %s from Settings before enabling the new Gateway",
    async (source) => {
      const unsubscribe = vi.fn(async () => {
        currentSubscription = null;
        return true;
      });
      const mismatchedSubscription = existingSubscription([4, 1, 2, 3]);
      mismatchedSubscription.unsubscribe = unsubscribe;
      let currentSubscription: PushSubscription | null =
        source === "reconnect" ? mismatchedSubscription : null;
      const subscribe = vi.fn(async () => {
        currentSubscription = existingSubscription([4, 9, 8, 7]);
        return currentSubscription;
      });
      const registration = {
        pushManager: {
          getSubscription: async () => currentSubscription,
          subscribe,
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      });
      vi.stubGlobal("Notification", {
        permission: "granted",
        requestPermission: vi.fn().mockResolvedValue("granted"),
      });
      const request = vi.fn(async (method: string) => {
        if (method === "push.web.vapidPublicKey") {
          return { vapidPublicKey: encodedVapidKey([4, 9, 8, 7]) };
        }
        if (method === "push.web.preferences.get") {
          return preferenceResult(notificationPreferences(true));
        }
        return { subscriptionId: "subscription-1", removed: true };
      });
      const harness = gatewayHarness();
      const capability = createWebPushCapability(harness.gateway);
      const container = document.createElement("div");
      const update = () => {
        render(
          renderNotificationsSection({
            connected: true,
            webPush: capability.snapshot,
            onWebPushSubscribe: () => void capability.run({ kind: "enable" }),
            onWebPushUnsubscribe: () => void capability.run({ kind: "disable" }),
          }),
          container,
        );
      };
      const stop = capability.subscribe(update);
      const button = (label: string) =>
        Array.from(container.querySelectorAll("button")).find((candidate) =>
          candidate.textContent?.includes(label),
        );

      try {
        harness.connect({ request } as unknown as GatewayBrowserClient);
        if (source === "enable") {
          await vi.waitFor(() => expect(capability.snapshot.subscription).toBe("missing"));
          currentSubscription = mismatchedSubscription;
          button("Enable notifications")?.click();
        }
        await vi.waitFor(() => expect(container.textContent).toContain("another Gateway"));
        expect(container.textContent).toContain("Not subscribed");
        expect(button("Send test")).toBeUndefined();
        const resetButton = button("Unsubscribe");
        expect(resetButton).toBeDefined();
        await vi.waitFor(() => expect(resetButton?.disabled).toBe(false));
        resetButton?.click();
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(button("Enable notifications")?.disabled).toBe(false));
        button("Enable notifications")?.click();

        await vi.waitFor(() => expect(button("Send test")?.disabled).toBe(false));
        expect(subscribe).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith("push.web.subscribe", {
          endpoint: "https://push.example.test/subscription",
          keys: { p256dh: "p256dh", auth: "auth" },
        });
        expect(container.textContent).not.toContain("another Gateway");
      } finally {
        stop();
        capability.dispose();
        render(nothing, container);
      }
    },
  );
});
