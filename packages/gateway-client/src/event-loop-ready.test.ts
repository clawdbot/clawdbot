import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForEventLoopReady } from "./event-loop-ready.js";

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
});
