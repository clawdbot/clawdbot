import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "./session-pull-requests.ts";
import { scopedSessionArtifactKey } from "./sessions/session-key.ts";

function createHello(): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [] },
    features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
  };
}

function createGatewayHarness() {
  const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ subscribed: true });
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: createHello(),
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const snapshotListeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const unsubscribeSnapshots = vi.fn();
  const unsubscribeEvents = vi.fn();
  const subscribeSnapshots = vi.fn((listener: (value: ApplicationGatewaySnapshot) => void) => {
    snapshotListeners.add(listener);
    return () => {
      unsubscribeSnapshots();
      snapshotListeners.delete(listener);
    };
  });
  const subscribeEvents = vi.fn((listener: GatewayEventListener) => {
    eventListeners.add(listener);
    return () => {
      unsubscribeEvents();
      eventListeners.delete(listener);
    };
  });
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    subscribe: subscribeSnapshots,
    subscribeEvents,
    subscribeEventLog: () => () => {},
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as ApplicationGateway;
  return {
    gateway,
    request,
    subscribeSnapshots,
    subscribeEvents,
    unsubscribeSnapshots,
    unsubscribeEvents,
    emit(payload: unknown, event = "controlUi.sessionPullRequests.changed") {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event,
          payload,
          seq: 1,
        });
      }
    },
    setSnapshot(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
  };
}

async function flushSync() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("session pull request snapshot store", () => {
  it("sends an empty replace-set while the tab is hidden", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:demo"]);
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: ["agent:main:demo"],
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [],
    });
    store.unwatch(owner);
    await flushSync();
  });

  it("retires snapshots and resubscribes normally across a same-client reconnect", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const key = "agent:main:demo";
    store.watch(owner, [key]);
    await flushSync();
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 1, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "open" }]);

    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
    expect(store.get(key)).toBeUndefined();

    harness.setSnapshot({
      ...harness.gateway.snapshot,
      phase: "connected",
      hello: createHello(),
    });
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [key],
    });
    store.unwatch(owner);
    await flushSync();
  });

  it.each(["new", "reset", "branch-switch", "fork", "rewind"])(
    "retires and force-refreshes only the matching session for %s",
    async (reason) => {
      const harness = createGatewayHarness();
      const store = sessionPullRequestsForGateway(harness.gateway);
      const owner = {};
      const listener = vi.fn();
      const globalAlias = reason === "rewind";
      harness.setSnapshot({
        ...harness.gateway.snapshot,
        hello: {
          ...createHello(),
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: globalAlias ? "global" : "agent:main:main",
              scope: globalAlias ? "global" : "per-sender",
            },
          },
        },
      });
      const key = globalAlias ? "agent:work:main" : "agent:main:demo";
      const otherKey = "agent:main:other";
      store.watch(owner, [key, otherKey]);
      const unsubscribe = store.subscribe(listener);
      await flushSync();
      harness.emit({
        sessions: {
          [key]: { pullRequests: [{ number: 1 }], rateLimited: false, status: "ready" },
          [otherKey]: { pullRequests: [{ number: 2 }], rateLimited: false, status: "ready" },
        },
      });
      harness.request.mockClear();
      listener.mockClear();

      harness.emit(
        {
          sessionKey: globalAlias ? "global" : key,
          agentId: globalAlias ? "work" : "main",
          reason,
        },
        "sessions.changed",
      );

      expect(store.get(key)).toBeUndefined();
      expect(store.get(otherKey)?.pullRequests).toEqual([{ number: 2 }]);
      expect(listener).toHaveBeenCalled();
      await flushSync();
      expect(harness.request).toHaveBeenCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
        sessionKeys: [key, otherKey].toSorted(),
        refreshSessionKeys: [key],
      });
      unsubscribe();
      store.unwatch(owner);
      await flushSync();
    },
  );

  it("keeps snapshots for ordinary send events", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const key = "agent:main:demo";
    store.watch(owner, [key]);
    await flushSync();
    harness.emit({
      sessions: {
        [key]: { pullRequests: [{ number: 1 }], rateLimited: false, status: "ready" },
      },
    });
    harness.request.mockClear();

    harness.emit({ sessionKey: key, agentId: "main", reason: "send" }, "sessions.changed");
    await flushSync();

    expect(store.get(key)?.pullRequests).toEqual([{ number: 1 }]);
    expect(harness.request).not.toHaveBeenCalled();
    store.unwatch(owner);
    await flushSync();
  });

  it("detaches document and gateway listeners after the last consumer leaves", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};

    expect(harness.subscribeSnapshots).not.toHaveBeenCalled();
    expect(harness.subscribeEvents).not.toHaveBeenCalled();
    store.watch(owner, ["agent:main:demo"]);
    const unsubscribe = store.subscribe(() => undefined);
    await flushSync();

    expect(harness.subscribeSnapshots).toHaveBeenCalledOnce();
    expect(harness.subscribeEvents).toHaveBeenCalledOnce();
    const visibilityListener = addEventListener.mock.calls.find(
      ([type]) => type === "visibilitychange",
    )?.[1];
    expect(visibilityListener).toBeTypeOf("function");

    store.unwatch(owner);
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [],
    });
    expect(harness.unsubscribeSnapshots).not.toHaveBeenCalled();
    expect(harness.unsubscribeEvents).not.toHaveBeenCalled();

    unsubscribe();
    await flushSync();
    expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
    expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith("visibilitychange", visibilityListener);
  });

  it("does not retry a failed subscribe after the store becomes idle", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    harness.request.mockRejectedValue(new Error("temporarily unavailable"));
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:demo"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(1);

    store.unwatch(owner);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resubscribes and accepts a fresh snapshot after becoming active again", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const key = "agent:main:demo";

    store.watch(owner, [key]);
    await flushSync();
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 1, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    expect(store.get(key)?.pullRequests).toEqual([{ number: 1, state: "open" }]);

    store.unwatch(owner);
    await flushSync();
    expect(store.get(key)).toBeUndefined();
    expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
    expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();

    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 99, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    store.watch(owner, [key]);
    await flushSync();
    expect(harness.subscribeSnapshots).toHaveBeenCalledTimes(2);
    expect(harness.subscribeEvents).toHaveBeenCalledTimes(2);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [key],
    });
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 2, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    expect(store.get(key)?.pullRequests).toEqual([{ number: 2, state: "open" }]);

    store.unwatch(owner);
    await flushSync();
  });

  it("reactivates a detached store for a standalone load", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const key = "agent:main:demo";
    store.watch(owner, [key]);
    await flushSync();
    store.unwatch(owner);
    await flushSync();
    harness.request.mockClear();

    const loaded = store.load({}, key);
    await flushSync();
    expect(harness.request).toHaveBeenCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [key],
    });
    harness.emit({
      sessions: {
        [key]: { pullRequests: [], rateLimited: false, status: "ready" },
      },
    });
    await expect(loaded).resolves.toMatchObject({ status: "ready" });
    await flushSync();
  });

  it("retries a transient subscription failure with bounded backoff", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    harness.request.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:demo"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(harness.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    store.unwatch(owner);
    await flushSync();
  });

  it("requests an immediate refresh for only the selected watched key", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:demo", "agent:main:other"]);
    await flushSync();
    harness.request.mockClear();

    expect(store.refresh("agent:main:unwatched")).toBe(false);
    expect(store.refresh("agent:main:demo")).toBe(true);
    expect(store.refresh("agent:main:demo")).toBe(true);
    await flushSync();

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.request).toHaveBeenCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: ["agent:main:demo", "agent:main:other"],
      refreshSessionKeys: ["agent:main:demo"],
    });
    store.unwatch(owner);
    await flushSync();
  });

  it("carries a pending refresh into a superseding replace-set", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const foregroundOwner = {};
    const otherOwner = {};
    store.watch(foregroundOwner, ["agent:main:demo"], { foreground: true });
    await flushSync();
    harness.request.mockClear();
    let resolveFirst!: (value: { subscribed: boolean }) => void;
    const first = new Promise<{ subscribed: boolean }>((resolve) => {
      resolveFirst = resolve;
    });
    harness.request.mockReturnValueOnce(first);

    store.refresh("agent:main:demo");
    await flushSync();
    store.watch(otherOwner, ["agent:main:other"]);
    await flushSync();

    expect(harness.request.mock.calls[1]?.[1]).toEqual({
      sessionKeys: ["agent:main:demo", "agent:main:other"],
      refreshSessionKeys: ["agent:main:demo"],
    });
    resolveFirst({ subscribed: true });
    store.unwatch(foregroundOwner);
    store.unwatch(otherOwner);
    await flushSync();
  });

  it("does not settle a one-shot load from an obsolete request failure", async () => {
    const harness = createGatewayHarness();
    let rejectFirst!: (error: Error) => void;
    harness.request.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    const store = sessionPullRequestsForGateway(harness.gateway);
    const loadOwner = {};
    const otherOwner = {};
    const loaded = store.load(loadOwner, "agent:main:demo");
    await flushSync();
    store.watch(otherOwner, ["agent:main:other"]);
    await flushSync();

    rejectFirst(new Error("obsolete request failed"));
    await flushSync();
    let settled = false;
    void loaded.then(() => {
      settled = true;
    });
    await flushSync();
    expect(settled).toBe(false);

    harness.emit({
      sessions: {
        "agent:main:demo": { pullRequests: [], rateLimited: false, status: "ready" },
      },
    });
    await expect(loaded).resolves.toMatchObject({ status: "ready" });
    store.unwatch(otherOwner);
    await flushSync();
  });

  it("does not resubscribe when foreground promotion only reorders watched keys", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const sidebarOwner = {};
    const hovercardOwner = {};
    store.watch(sidebarOwner, ["agent:main:first", "agent:main:second"]);
    await flushSync();
    harness.request.mockClear();

    store.watch(hovercardOwner, ["agent:main:second"], { foreground: true });
    await flushSync();
    expect(harness.request).not.toHaveBeenCalled();

    store.unwatch(hovercardOwner);
    await flushSync();
    expect(harness.request).not.toHaveBeenCalled();

    store.unwatch(sidebarOwner);
    await flushSync();
  });

  it("resubscribes when foreground promotion changes the bounded server union", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const normalOwner = {};
    const foregroundOwner = {};
    store.watch(
      normalOwner,
      Array.from({ length: 201 }, (_value, index) => `normal-${String(index).padStart(3, "0")}`),
    );
    await flushSync();
    harness.request.mockClear();

    store.watch(foregroundOwner, ["normal-200"], { foreground: true });
    await flushSync();

    expect(harness.request).toHaveBeenCalledOnce();
    const params = harness.request.mock.lastCall?.[1] as { sessionKeys: string[] };
    expect(params.sessionKeys).toHaveLength(200);
    expect(params.sessionKeys[0]).toBe("normal-200");
    expect(params.sessionKeys).not.toContain("normal-199");
    store.unwatch(normalOwner);
    store.unwatch(foregroundOwner);
    await flushSync();
  });

  it("merges an empty rate-limit delta with the last known snapshot", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const key = "agent:main:demo";
    const owner = {};
    store.watch(owner, [key]);
    await flushSync();
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 1, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [],
          branch: { owner: "openclaw", repo: "openclaw", branch: "feature/demo" },
          rateLimited: true,
          status: "rate-limited",
        },
      },
    });

    expect(store.get(key)).toMatchObject({
      pullRequests: [{ number: 1, state: "open" }],
      branch: { branch: "feature/demo" },
      rateLimited: true,
      status: "rate-limited",
    });
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [],
          rateLimited: false,
          status: "unavailable",
        },
      },
    });
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [],
          rateLimited: false,
          status: "unavailable",
        },
      },
    });
    expect(store.get(key)).toMatchObject({
      pullRequests: [{ number: 1, state: "open" }],
      status: "unavailable",
    });
    store.unwatch(owner);
    await flushSync();
  });

  it("does not leave one-shot loads pending while disconnected", async () => {
    const harness = createGatewayHarness();
    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};

    await expect(store.load(owner, "agent:main:demo")).resolves.toBeUndefined();
    store.unwatch(owner);
  });

  it("settles a pending one-shot load when its key leaves the active union", async () => {
    const harness = createGatewayHarness();
    harness.request.mockReturnValue(new Promise<never>(() => {}));
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const loaded = store.load(owner, "agent:main:demo");
    await flushSync();

    store.unwatch(owner);

    await expect(loaded).resolves.toBeUndefined();
  });

  it("automatically releases a one-shot watch after its snapshot settles", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const loaded = store.load({}, "agent:main:demo");
    await flushSync();
    harness.emit({
      sessions: {
        "agent:main:demo": { pullRequests: [], rateLimited: false, status: "ready" },
      },
    });
    await loaded;
    await flushSync();

    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: [],
    });
  });

  it("settles a pending one-shot load when the gateway disconnects", async () => {
    const harness = createGatewayHarness();
    harness.request.mockReturnValue(new Promise<never>(() => {}));
    const store = sessionPullRequestsForGateway(harness.gateway);
    const loaded = store.load({}, "agent:main:demo");
    await flushSync();

    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
    await flushSync();

    await expect(loaded).resolves.toBeUndefined();
  });

  it("scopes global aliases without changing canonical keys", () => {
    expect(scopedSessionArtifactKey("global", "Work")).toBe("agent:work:global");
    expect(scopedSessionArtifactKey("agent:work:main", "main")).toBe("agent:work:main");
  });
});
