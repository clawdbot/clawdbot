import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForEventLoopReady } from "./event-loop-ready.js";

describe("waitForEventLoopReady", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves ready after consecutive low-drift timer checks", async () => {
    vi.useFakeTimers();

    const promise = waitForEventLoopReady({
      maxWaitMs: 100,
      intervalMs: 10,
      consecutiveReadyChecks: 2,
    });

    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toMatchObject({
      ready: true,
      aborted: false,
      elapsedMs: 20,
      checks: 2,
      maxDriftMs: 0,
    });
  });

  it("resolves not-ready when the readiness deadline expires", async () => {
    vi.useFakeTimers();

    const promise = waitForEventLoopReady({
      maxWaitMs: 5,
      intervalMs: 5,
      consecutiveReadyChecks: 2,
    });

    await vi.advanceTimersByTimeAsync(5);

    await expect(promise).resolves.toMatchObject({
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

    const promise = waitForEventLoopReady({
      maxWaitMs: 100,
      intervalMs: 10,
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).resolves.toMatchObject({
      ready: false,
      aborted: true,
      elapsedMs: 0,
      checks: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
