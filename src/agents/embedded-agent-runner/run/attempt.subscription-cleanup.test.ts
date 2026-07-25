// Coverage for ordered cleanup of embedded attempt subscriptions and resources.
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt.abort-settle-timeout.js";
import { cleanupEmbeddedAttemptResources } from "./attempt.subscription-cleanup.js";

function createDeferred<T>() {
  // Manual deferreds let cleanup tests prove ordering around abort settlement.
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("cleanupEmbeddedAttemptResources", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for aborted prompt settlement before flushing and releasing the lock", async () => {
    // After an abort, pending prompt work gets a short chance to settle before
    // session flush/release/dispose run.
    const order: string[] = [];
    const settle = createDeferred<void>();

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
      sessionLock: {
        release: async () => {
          order.push("release");
        },
      },
      aborted: true,
      abortSettlePromise: settle.promise,
      runId: "run-1",
      sessionId: "session-1",
    });

    await Promise.resolve();

    expect(order).toEqual(["guard"]);

    settle.resolve();
    await cleanupPromise;

    expect(order).toEqual(["guard", "flush", "release", "dispose"]);
  });

  it("releases the lock after the aborted settle timeout", async () => {
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
      sessionLock: {
        release: async () => {
          order.push("release");
        },
      },
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

    expect(order).toEqual(["flush", "release", "dispose"]);
  });

  it("releases the lock before runtime teardown can hang", async () => {
    // Bundle runtime disposal can hang; release transcript locks first so other
    // turns are not blocked by diagnostic cleanup.
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
      sessionLock: {
        release: async () => {
          order.push("release");
        },
      },
      bundleMcpRuntime: {
        dispose: async () => {
          order.push("runtime-dispose-start");
          markRuntimeDisposeStarted();
          await new Promise(() => {});
        },
      },
    });

    await runtimeDisposeStarted;

    expect(order).toEqual(["flush", "release", "dispose", "runtime-dispose-start"]);
  });

  it("does not wait for the settle promise on non-aborted cleanup", async () => {
    const release = vi.fn(async () => {});

    await cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle: vi.fn(async () => {}),
      session: {
        agent: {},
        dispose: vi.fn(),
      },
      sessionManager: {},
      sessionLock: { release },
      aborted: false,
      abortSettlePromise: new Promise(() => {}),
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("still disposes resources when lock release fails", async () => {
    const releaseError = new Error("release failed");
    const dispose = vi.fn();
    const runtimeDispose = vi.fn(async () => {});

    await expect(
      cleanupEmbeddedAttemptResources({
        flushPendingToolResultsAfterIdle: vi.fn(async () => {}),
        session: {
          agent: {},
          dispose,
        },
        sessionManager: {},
        sessionLock: {
          release: async () => {
            throw releaseError;
          },
        },
        bundleMcpRuntime: {
          dispose: runtimeDispose,
        },
      }),
    ).rejects.toBe(releaseError);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("can skip stale session-manager flushing after session takeover", async () => {
    const flushPendingToolResultsAfterIdle = vi.fn(async () => {});
    const order: string[] = [];
    const dispose = vi.fn(() => {
      order.push("dispose");
    });
    const release = vi.fn(async () => {
      order.push("release");
    });

    await cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle,
      session: {
        agent: {},
        dispose,
      },
      sessionManager: {},
      sessionLock: { release },
      skipSessionFlush: true,
    });

    expect(flushPendingToolResultsAfterIdle).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["release", "dispose"]);
  });
});
