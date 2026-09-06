// Coverage for ordered cleanup of embedded attempt subscriptions and resources.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS", "1250");
  vi.stubEnv("OPENCLAW_TEST_FAST", undefined);
  // Timeout policy is captured at module load, once per cleanup owner lifetime.
  vi.resetModules();
  mocks.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("waitForEmbeddedAbortSettle timeout policy", () => {
  it.each([
    { override: "1250", fast: undefined, timeoutMs: 1_250 },
    { override: "0x10", fast: undefined, timeoutMs: 2_000 },
    { override: "1e3", fast: undefined, timeoutMs: 2_000 },
    { override: "12.5", fast: undefined, timeoutMs: 2_000 },
    { override: "10ms", fast: "1", timeoutMs: 250 },
  ])(
    "waits $timeoutMs ms with override=$override and fast=$fast",
    async ({ override, fast, timeoutMs }) => {
      vi.stubEnv("OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS", override);
      vi.stubEnv("OPENCLAW_TEST_FAST", fast);
      const { waitForEmbeddedAbortSettle } = await import("./attempt-subscription-cleanup.js");
      let settled = false;
      const wait = waitForEmbeddedAbortSettle({
        promise: new Promise(() => {}),
        runId: "run-1",
        sessionId: "session-1",
      }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(settled).toBe(false);
      expect(mocks.warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await wait;

      expect(settled).toBe(true);
      expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
        `agent cleanup timed out: runId=run-1 sessionId=session-1 step=embedded-abort-settle timeoutMs=${timeoutMs}`,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("waitForSessionsYieldAbortSettle", () => {
  it("logs the yield-specific warning and clears its timer after timeout", async () => {
    const { waitForSessionsYieldAbortSettle } = await import("./attempt-sessions-yield.js");
    const wait = waitForSessionsYieldAbortSettle({
      settlePromise: new Promise(() => {}),
      runId: "run-1",
      sessionId: "session-1",
    });

    await vi.advanceTimersByTimeAsync(1_250);
    await wait;

    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      "agent cleanup timed out: runId=run-1 sessionId=session-1 step=sessions_yield-abort-settle timeoutMs=1250",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs rejected settlement and clears its pending timer", async () => {
    const { waitForSessionsYieldAbortSettle } = await import("./attempt-sessions-yield.js");
    await waitForSessionsYieldAbortSettle({
      settlePromise: Promise.reject(new Error("settle failed")),
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      "agent cleanup failed: runId=run-1 sessionId=session-1 step=sessions_yield-abort-settle error=settle failed",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips missing settlement without scheduling a timer", async () => {
    const { waitForSessionsYieldAbortSettle } = await import("./attempt-sessions-yield.js");
    await waitForSessionsYieldAbortSettle({
      settlePromise: null,
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cleanupEmbeddedAttemptResources", () => {
  it("waits for aborted prompt settlement before flushing and disposing", async () => {
    const { cleanupEmbeddedAttemptResources } = await import("./attempt-subscription-cleanup.js");
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
    const { cleanupEmbeddedAttemptResources } = await import("./attempt-subscription-cleanup.js");
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

    const abortSettleTimeoutMs = 1_250;
    await vi.advanceTimersByTimeAsync(abortSettleTimeoutMs - 1);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await cleanupPromise;

    expect(order).toEqual(["flush", "dispose"]);
    expect(mocks.warn).toHaveBeenCalledWith(
      `agent cleanup timed out: runId=run-1 sessionId=session-1 step=embedded-abort-settle timeoutMs=${abortSettleTimeoutMs}`,
    );
  });

  it("disposes the session before runtime teardown can hang", async () => {
    const { cleanupEmbeddedAttemptResources } = await import("./attempt-subscription-cleanup.js");
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
    const { cleanupEmbeddedAttemptResources } = await import("./attempt-subscription-cleanup.js");
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
