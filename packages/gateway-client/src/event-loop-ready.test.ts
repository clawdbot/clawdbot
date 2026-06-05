// Gateway Client tests cover event loop ready behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForEventLoopReady } from "./event-loop-ready.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "./timeouts.js";

describe("waitForEventLoopReady", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back when maxWaitMs is non-finite instead of arming a NaN timer", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const readiness = waitForEventLoopReady({
      maxWaitMs: Number.NaN,
      intervalMs: 25,
      consecutiveReadyChecks: 2,
    });

    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 25);

    await vi.advanceTimersByTimeAsync(50);
    await expect(readiness).resolves.toMatchObject({
      ready: true,
      checks: 2,
    });
  });

  it("clamps oversized readiness intervals before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const readiness = waitForEventLoopReady({
      maxWaitMs: Number.MAX_SAFE_INTEGER,
      intervalMs: Number.MAX_SAFE_INTEGER,
      consecutiveReadyChecks: 1,
    });

    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);

    await vi.advanceTimersByTimeAsync(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS - 1);
    await expect(readiness).resolves.toMatchObject({
      ready: true,
      checks: 1,
    });
  });
});
