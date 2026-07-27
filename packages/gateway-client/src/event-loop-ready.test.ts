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

  it("resolves ready after consecutive low-drift timer checks", async () => {
    vi.useFakeTimers();

    const readiness = waitForEventLoopReady({
      maxWaitMs: 100,
      intervalMs: 10,
      consecutiveReadyChecks: 2,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(readiness).resolves.toEqual({
      ready: true,
      aborted: false,
      elapsedMs: 20,
      checks: 2,
      maxDriftMs: 0,
    });
  });

  it("resolves not-ready when the readiness deadline expires", async () => {
    vi.useFakeTimers();

    const readiness = waitForEventLoopReady({
      maxWaitMs: 5,
      intervalMs: 5,
      consecutiveReadyChecks: 2,
    });

    await vi.advanceTimersByTimeAsync(5);

    await expect(readiness).resolves.toEqual({
      ready: false,
      aborted: false,
      elapsedMs: 5,
      checks: 1,
      maxDriftMs: 0,
    });
  });

  it("clears pending readiness timers when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const readiness = waitForEventLoopReady({
      maxWaitMs: 100,
      intervalMs: 10,
      signal: controller.signal,
    });

    controller.abort();

    await expect(readiness).resolves.toEqual({
      ready: false,
      aborted: true,
      elapsedMs: 0,
      maxDriftMs: 0,
      checks: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
