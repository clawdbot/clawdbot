import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import {
  EMBEDDED_ABORT_SETTLE_TIMEOUT_MS,
  cleanupEmbeddedAttemptResources,
} from "./attempt.subscription-cleanup.js";

function createDeferred<T>() {
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

  it("waits for aborted prompt settlement before flushing, disposing, and releasing the lock", async () => {
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

    expect(order).toEqual(["guard", "flush", "dispose", "release"]);
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

    await vi.advanceTimersByTimeAsync(EMBEDDED_ABORT_SETTLE_TIMEOUT_MS - 1);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await cleanupPromise;

    expect(order).toEqual(["flush", "dispose", "release"]);
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

  it("can skip stale session-manager flushing after session takeover", async () => {
    const flushPendingToolResultsAfterIdle = vi.fn(async () => {});
    const dispose = vi.fn();
    const release = vi.fn(async () => {});

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
  });
});
