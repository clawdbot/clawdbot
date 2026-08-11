import { describe, expect, it, vi } from "vitest";
import {
  ControlModelDisposedError,
  ControlModelSubscriberLimitError,
  createControlModel,
  type ControlModelConnectionSnapshot,
  type ControlModelGatewayBinding,
  type ControlModelGatewayEvent,
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
  const eventListeners = new Set<(event: ControlModelGatewayEvent) => void>();
  const requests: Array<ReturnType<typeof deferred<SessionListResult>>> = [];
  const request = vi.fn(() => {
    const pending = deferred<SessionListResult>();
    requests.push(pending);
    return pending.promise;
  });
  const gateway: ControlModelGatewayBinding = {
    getConnectionSnapshot: () => connection,
    subscribeConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    request,
  };
  return {
    gateway,
    request,
    requests,
    setConnection(next: ControlModelConnectionSnapshot) {
      connection = next;
      for (const listener of connectionListeners) {
        listener();
      }
    },
    emit(event: ControlModelGatewayEvent) {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Control Model session catalog", () => {
  it("publishes deeply immutable bounded session snapshots", async () => {
    const harness = createGatewayHarness();
    const model = createControlModel({
      gateway: harness.gateway,
      bounds: { maxSessions: 1 },
      now: () => 42,
    });
    model.start();
    const refresh = model.refreshSessions();
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
    await refresh;

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

  it("coalesces live invalidations and rejects retired-epoch results", async () => {
    const harness = createGatewayHarness();
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    await flushMicrotasks();
    expect(harness.requests).toHaveLength(1);

    harness.emit({ event: "sessions.changed" });
    harness.emit({ event: "sessions.changed" });
    harness.setConnection({ status: "reconnecting", epoch: 2 });
    harness.setConnection({ status: "connected", epoch: 2 });
    harness.requests[0]?.resolve({
      sessions: [{ key: "agent:main:stale", kind: "direct" }],
    });
    await flushMicrotasks();
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

  it("reconciles create, update, and delete through canonical refreshes", async () => {
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    harness.setConnection({ status: "connected", epoch: 1 });
    await flushMicrotasks();
    harness.requests[0]?.resolve({
      sessions: [{ key: "agent:main:one", kind: "direct", label: "First" }],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.status).toBe("ready");
    });

    harness.emit({ event: "sessions.changed" });
    await flushMicrotasks();
    harness.requests[1]?.resolve({
      sessions: [
        { key: "agent:main:one", kind: "direct", label: "Updated" },
        { key: "agent:main:two", kind: "direct" },
      ],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.sessions).toHaveLength(2);
    });

    harness.emit({ event: "sessions.changed" });
    await flushMicrotasks();
    harness.requests[2]?.resolve({
      sessions: [{ key: "agent:main:two", kind: "direct" }],
    });
    await vi.waitFor(() => {
      expect(model.getSnapshot().sessionCatalog.sessions).toHaveLength(1);
    });
    expect(model.getSnapshot().sessionCatalog.sessions[0]?.key).toBe("agent:main:two");
  });

  it("publishes structured request failures and preserves rejection", async () => {
    const harness = createGatewayHarness({ status: "disconnected", epoch: 0 });
    const model = createControlModel({ gateway: harness.gateway });
    model.start();
    harness.setConnection({ status: "connected", epoch: 1 });
    await flushMicrotasks();
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
