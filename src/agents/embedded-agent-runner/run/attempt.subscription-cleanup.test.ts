// Coverage for ordered cleanup of embedded attempt subscriptions and resources.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { log } from "../logger.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt-finalize.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";

describe("cleanupEmbeddedAttemptResources", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for aborted prompt settlement before flushing and disposing", async () => {
    // After an abort, pending prompt work gets a short chance to settle before
    // session flush/release/dispose run.
    const order: string[] = [];
    const settle = createDeferred();

    const cleanupPromise = cleanupEmbeddedAttemptResources({
      removeToolResultContextGuard: () => {
        order.push("guard");
      },
      flushPendingToolResultsAfterIdle: vi.fn(async () => {
        order.push("flush");
      }),
      session: {
        agent: {},
        dispose: () => {
          order.push("dispose");
        },
      },
      sessionManager: {},
      aborted: true,
      abortSettlePromise: settle.promise,
      runId: "run-1",
      sessionId: "session-1",
    });

    await Promise.resolve();

    expect(order).toEqual(["guard"]);

    settle.resolve();
    await cleanupPromise;

    expect(order).toEqual(["guard", "flush", "dispose"]);
  });

  it("continues cleanup after the aborted settle timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const order: string[] = [];

    const cleanupPromise = cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle: vi.fn(async () => {
        order.push("flush");
      }),
      session: {
        agent: {},
        dispose: () => {
          order.push("dispose");
        },
      },
      sessionManager: {},
      aborted: true,
      abortSettlePromise: new Promise(() => {}),
      runId: "run-1",
      sessionId: "session-1",
    });

    const abortSettleTimeoutMs = resolveEmbeddedAbortSettleTimeoutMs();
    await vi.advanceTimersByTimeAsync(abortSettleTimeoutMs - 1);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await cleanupPromise;

    expect(order).toEqual(["flush", "dispose"]);
  });

  it("disposes the session before runtime teardown can hang", async () => {
    const order: string[] = [];
    let markRuntimeDisposeStarted!: () => void;
    const runtimeDisposeStarted = new Promise<void>((resolve) => {
      markRuntimeDisposeStarted = resolve;
    });

    void cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle: vi.fn(async () => {
        order.push("flush");
      }),
      session: {
        agent: {},
        dispose: () => {
          order.push("dispose");
        },
      },
      sessionManager: {},
      bundleMcpRuntime: {
        dispose: async () => {
          order.push("runtime-dispose-start");
          markRuntimeDisposeStarted();
          await new Promise(() => {});
        },
      },
    });

    await runtimeDisposeStarted;

    expect(order).toEqual(["flush", "dispose", "runtime-dispose-start"]);
  });

  it("does not wait for the settle promise on non-aborted cleanup", async () => {
    const dispose = vi.fn();

    await cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle: vi.fn(async () => {}),
      session: {
        agent: {},
        dispose,
      },
      sessionManager: {},
      aborted: false,
      abortSettlePromise: new Promise(() => {}),
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
