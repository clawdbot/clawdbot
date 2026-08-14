import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewaySessionMessageSubscriptionCoordinator } from "../browser.js";
import {
  ControlModelDisposedError,
  ControlModelSubscriberLimitError,
  createControlModel,
  type ControlModelConnectionSnapshot,
  type ControlModelGatewayEventFrame,
  type ControlModelGatewayBinding,
  type ControlModelRequestOptions,
} from "./index.js";

type SessionListResult = {
  sessions: Array<Record<string, unknown>>;
  totalCount?: number;
  hasMore?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createGatewayHarness(
  initial: ControlModelConnectionSnapshot = { status: "connected", epoch: 1 },
) {
  let connection = initial;
  const connectionListeners = new Set<() => void>();
  const invalidationListeners = new Set<() => void>();
  const eventListeners = new Set<(frame: ControlModelGatewayEventFrame) => void>();
  const unsubscribeInvalidations = vi.fn();
  const subscribeInvalidations = vi.fn((listener: () => void) => {
    invalidationListeners.add(listener);
    return () => {
      invalidationListeners.delete(listener);
      unsubscribeInvalidations();
    };
  });
  const requests: Array<ReturnType<typeof deferred<SessionListResult>>> = [];
  const requestCalls: Array<{
    method: string;
    params: Record<string, unknown>;
    options: ControlModelRequestOptions | undefined;
  }> = [];
  const request = vi.fn(
    (method: string, params: Record<string, unknown>, options?: ControlModelRequestOptions) => {
      requestCalls.push({ method, params, options });
      const pending = deferred<SessionListResult>();
      requests.push(pending);
      return pending.promise;
    },
  );
  let coordinator: GatewaySessionMessageSubscriptionCoordinator;
  const gateway: ControlModelGatewayBinding = {
    getConnectionSnapshot: () => connection,
    subscribeConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    subscribeSessionCatalogInvalidations: subscribeInvalidations,
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getMessageSubscriptionCoordinator() {
      return coordinator;
    },
    request,
  };
  coordinator = new GatewaySessionMessageSubscriptionCoordinator(gateway);
  return {
    gateway,
    request,
    requests,
    requestCalls,
    subscribeInvalidations,
    unsubscribeInvalidations,
    setConnection(next: ControlModelConnectionSnapshot) {
      connection = next;
      for (const listener of connectionListeners) {
        listener();
      }
    },
    emitInvalidation() {
      for (const listener of invalidationListeners) {
        listener();
      }
    },
    emitEvent(frame: {
      event: string;
      payload?: unknown;
      connectionEpoch?: number;
      seq?: number;
      gap?: boolean;
    }) {
      for (const listener of eventListeners)
        listener({ connectionEpoch: connection.epoch, ...frame });
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Control Model session catalog", () => {
  it("activates and disposes the host-owned invalidation subscription", () => {
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    model.start();
    expect(harness.subscribeInvalidations).toHaveBeenCalledTimes(1);
    model.dispose();
    expect(harness.unsubscribeInvalidations).toHaveBeenCalledTimes(1);
  });

  it("publishes deeply immutable bounded session snapshots", async () => {
    const harness = createGatewayHarness();
    const model = createControlModel({
      gateway: harness.gateway,
      bounds: { maxSessions: 1 },
      now: () => 42,
    });
    model.start();
    harness.requests[0]?.resolve({
      sessions: [
        {
          key: "agent:main:one",
          kind: "direct",
          worktree: { id: "one", branch: "main", repoRoot: "C:\\repo" },
        },
        { key: "agent:main:two", kind: "direct" },
      ],
      totalCount: 2,
      hasMore: true,
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("ready");
    });

    const snapshot = model.getSnapshot();
    expect(harness.request).toHaveBeenCalledWith("sessions.list", { limit: 1 }, undefined);
    expect(snapshot.sessionCatalog).toMatchObject({
      status: "ready",
      totalCount: 2,
      hasMore: true,
      refreshedAt: 42,
    });
    expect(snapshot.sessionCatalog.sessions).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sessionCatalog.sessions)).toBe(true);
    expect(Object.isFrozen(snapshot.sessionCatalog.sessions[0]?.worktree)).toBe(true);
  });

  it("coalesces invalidations and never publishes a retired-epoch result", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    await flushMicrotasks();
    expect(harness.requests).toHaveLength(1);

    harness.emitInvalidation();
    harness.emitInvalidation();
    await vi.advanceTimersByTimeAsync(200);
    harness.setConnection({ status: "reconnecting", epoch: 2 });
    harness.setConnection({ status: "connected", epoch: 2 });
    harness.requests[0]?.resolve({
      sessions: [{ key: "agent:main:stale", kind: "direct" }],
    });
    await flushMicrotasks();
    expect(model.getSnapshot().sessionCatalog.sessions).toEqual([]);
    expect(harness.requests).toHaveLength(2);

    harness.requests[1]?.resolve({
      sessions: [{ key: "agent:main:current", kind: "direct" }],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("ready");
    });
    expect(model.getSnapshot().sessionCatalog.sessions.map((session) => session.key)).toEqual([
      "agent:main:current",
    ]);
  });

  it("retires stale request failures without publishing them", async () => {
    const harness = createGatewayHarness();
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    await flushMicrotasks();
    harness.setConnection({ status: "reconnecting", epoch: 2 });
    harness.setConnection({ status: "connected", epoch: 2 });
    harness.requests[0]?.reject(new Error("retired failure"));
    await flushMicrotasks();
    expect(harness.requests).toHaveLength(2);
    expect(model.getSnapshot().sessionCatalog.error).toBeNull();
    harness.requests[1]?.resolve({
      sessions: [{ key: "agent:main:current", kind: "direct" }],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("ready");
    });
  });

  it("reconciles create, update, and delete through canonical refreshes", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    harness.setConnection({ status: "connected", epoch: 1 });
    harness.requests[0]?.resolve({
      sessions: [{ key: "agent:main:one", kind: "direct", label: "First" }],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("ready");
    });

    harness.emitInvalidation();
    await vi.advanceTimersByTimeAsync(200);
    harness.requests[1]?.resolve({
      sessions: [
        { key: "agent:main:one", kind: "direct", label: "Updated" },
        { key: "agent:main:two", kind: "direct" },
      ],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.sessions).toHaveLength(2);
    });

    harness.emitInvalidation();
    await vi.advanceTimersByTimeAsync(200);
    harness.requests[2]?.resolve({
      sessions: [{ key: "agent:main:two", kind: "direct" }],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.sessions).toHaveLength(1);
    });
    expect(model.getSnapshot().sessionCatalog.sessions[0]?.key).toBe("agent:main:two");
  });

  it("runs a trailing invalidation refresh after an active refresh fails", async () => {
    vi.useFakeTimers();
    const backgroundErrors: unknown[] = [];
    const harness = createGatewayHarness();
    const model = createControlModel({
      gateway: harness.gateway,
      onBackgroundError: (error) => backgroundErrors.push(error),
    });
    model.start();
    await flushMicrotasks();
    harness.emitInvalidation();
    await vi.advanceTimersByTimeAsync(200);
    harness.requests[0]?.reject(new Error("first refresh failed"));
    await vi.waitFor(() => {
      expect(harness.requests).toHaveLength(2);
    });
    harness.requests[1]?.resolve({
      sessions: [{ key: "agent:main:recovered", kind: "direct" }],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("ready");
    });
    expect(backgroundErrors).toHaveLength(1);
  });

  it("preserves explicit request options across background invalidations", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const model = createControlModel({ gateway: harness.gateway });
    const controller = new AbortController();
    model.start();
    await flushMicrotasks();
    const refresh = model.refreshSessions({ signal: controller.signal });
    harness.emitInvalidation();
    await vi.advanceTimersByTimeAsync(200);
    harness.requests[0]?.resolve({ sessions: [] });
    await flushMicrotasks();
    expect(harness.requests).toHaveLength(2);
    expect(harness.requestCalls[1]?.options?.signal).toBe(controller.signal);
    harness.requests[1]?.resolve({ sessions: [] });
    await refresh;
    await flushMicrotasks();
    expect(harness.requests).toHaveLength(2);
  });

  it("publishes structured request failures", async () => {
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    harness.setConnection({ status: "connected", epoch: 1 });
    const error = Object.assign(new Error("temporarily unavailable"), {
      code: "UNAVAILABLE",
      retryable: true,
    });
    harness.requests[0]?.reject(error);

    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("error");
    });
    expect(model.getSnapshot().sessionCatalog.error).toEqual({
      code: "UNAVAILABLE",
      message: "temporarily unavailable",
      retryable: true,
    });
  });

  it("rejects refreshes even when the gateway rejects without a reason", async () => {
    const harness = createGatewayHarness();
    const model = createControlModel({ gateway: harness.gateway });
    const refresh = model.refreshSessions();
    harness.requests[0]?.reject(undefined);

    await expect(refresh).rejects.toThrow("Session catalog refresh failed");
    expect(model.getSnapshot().sessionCatalog.status).toBe("error");
  });

  it("isolates throwing and slow subscribers from event delivery", async () => {
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const subscriberErrors: unknown[] = [];
    const model = createControlModel({
      gateway: harness.gateway,
      onSubscriberError: (error) => subscriberErrors.push(error),
    });
    const slow = deferred<void>();
    const observed: number[] = [];
    model.subscribe(() => {
      throw new Error("subscriber failed");
    });
    model.subscribe(() => slow.promise);
    model.subscribe(() => {
      observed.push(model.getSnapshot().revision);
    });
    model.start();
    harness.setConnection({ status: "connecting", epoch: 1 });
    harness.setConnection({ status: "reconnecting", epoch: 1 });
    await flushMicrotasks();

    expect(observed).toHaveLength(1);
    expect(subscriberErrors).toHaveLength(1);
    slow.reject(new Error("slow subscriber failed"));
    await flushMicrotasks();
    expect(subscriberErrors).toHaveLength(2);
  });

  it("stops notifying copied subscribers when one disposes the model", async () => {
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const model = createControlModel({ gateway: harness.gateway });
    const laterSubscriber = vi.fn();
    model.subscribe(() => model.dispose());
    model.subscribe(laterSubscriber);
    model.start();
    await flushMicrotasks();
    expect(laterSubscriber).not.toHaveBeenCalled();
  });

  it("reports more rows when the response exceeds the local bound", async () => {
    const harness = createGatewayHarness();
    const model = createControlModel({
      gateway: harness.gateway,
      bounds: { maxSessions: 1 },
    });
    model.start();
    harness.requests[0]?.resolve({
      sessions: [
        { key: "agent:main:one", kind: "direct" },
        { key: "agent:main:two", kind: "direct" },
      ],
      hasMore: false,
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("ready");
    });
    expect(model.getSnapshot().sessionCatalog.hasMore).toBe(true);
  });

  it("enforces subscriber bounds and disposal", () => {
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const model = createControlModel({
      gateway: harness.gateway,
      bounds: { maxSubscribers: 1 },
    });
    model.subscribe(() => {});
    expect(() => model.subscribe(() => {})).toThrow(ControlModelSubscriberLimitError);
    model.dispose();
    expect(model.getSnapshot().lifecycle).toBe("disposed");
    expect(() => model.start()).toThrow(ControlModelDisposedError);
    expect(() => model.refreshSessions()).toThrow(ControlModelDisposedError);
  });
});
