import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import {
  scopedSessionPullRequestKey,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "./session-pull-requests.ts";

function createGatewayHarness() {
  const request = vi.fn().mockResolvedValue({ subscribed: true });
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: { features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] } },
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
  const snapshotListeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    eventLog: [],
    subscribe(listener: (value: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    subscribeEventLog: () => () => {},
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as ApplicationGateway;
  return {
    gateway,
    request,
    emit(payload: unknown) {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event: "controlUi.sessionPullRequests.changed",
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
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("session pull request snapshot store", () => {
  it("sends an empty replace-set while the tab is hidden", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    store.watch({}, ["agent:main:demo"]);
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
  });

  it("resubscribes the current union after reconnect", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    store.watch({}, ["agent:main:demo"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(1);

    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
    harness.setSnapshot({
      ...harness.gateway.snapshot,
      phase: "connected",
      hello: { features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] } },
    });
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: ["agent:main:demo"],
    });
  });

  it("retries a transient subscription failure with bounded backoff", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    harness.request.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const store = sessionPullRequestsForGateway(harness.gateway);
    store.watch({}, ["agent:main:demo"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(harness.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
  });

  it("requests an immediate refresh for only the selected watched key", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    store.watch({}, ["agent:main:demo", "agent:main:other"]);
    await flushSync();
    harness.request.mockClear();

    store.refresh("agent:main:demo");
    await flushSync();

    expect(harness.request).toHaveBeenCalledWith(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys: ["agent:main:demo", "agent:main:other"],
      refreshSessionKeys: ["agent:main:demo"],
    });
  });

  it("carries a pending refresh into a superseding replace-set", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const foregroundOwner = {};
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
    store.watch({}, ["agent:main:other"]);
    await flushSync();

    expect(harness.request.mock.calls[1]?.[1]).toEqual({
      sessionKeys: ["agent:main:demo", "agent:main:other"],
      refreshSessionKeys: ["agent:main:demo"],
    });
    resolveFirst({ subscribed: true });
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
    const loaded = store.load({}, "agent:main:demo");
    await flushSync();
    store.watch({}, ["agent:main:other"]);
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
  });

  it("keeps foreground keys inside the bounded server union", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    store.watch(
      {},
      Array.from({ length: 201 }, (_value, index) => `normal-${String(index).padStart(3, "0")}`),
    );
    store.watch({}, ["zz-foreground"], { foreground: true });
    await flushSync();

    const params = harness.request.mock.calls[0]?.[1] as { sessionKeys: string[] };
    expect(params.sessionKeys).toHaveLength(200);
    expect(params.sessionKeys).toContain("zz-foreground");
  });

  it("merges an empty rate-limit delta with the last known snapshot", async () => {
    const harness = createGatewayHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const key = "agent:main:demo";
    store.watch({}, [key]);
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
    expect(scopedSessionPullRequestKey("global", "Work")).toBe("agent:work:global");
    expect(scopedSessionPullRequestKey("agent:work:main", "main")).toBe("agent:work:main");
  });
});
