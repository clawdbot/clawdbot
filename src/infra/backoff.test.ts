import { describe, expect, it, vi } from "vitest";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "./backoff.js";

describe("backoff helpers", () => {
  const policy: BackoffPolicy = {
    initialMs: 100,
    maxMs: 250,
    factor: 2,
    jitter: 0.5,
  };

  it("treats attempts below one as the first backoff step", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(computeBackoff(policy, 0)).toBe(100);
      expect(computeBackoff(policy, 1)).toBe(100);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("adds jitter and clamps to maxMs", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      expect(computeBackoff(policy, 2)).toBe(250);
      expect(computeBackoff({ ...policy, maxMs: 450 }, 2)).toBe(300);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("returns immediately for non-positive sleep durations", async () => {
    await expect(sleepWithAbort(0, AbortSignal.abort())).resolves.toBeUndefined();
    await expect(sleepWithAbort(-5)).resolves.toBeUndefined();
  });

  it("wraps aborted sleeps with a stable aborted error", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleepWithAbort(5, controller.signal)).rejects.toMatchObject({
      message: "aborted",
      cause: expect.anything(),
    });
  });

  it("advances with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const sleeper = sleepWithAbort(50);
      await vi.advanceTimersByTimeAsync(49);
      await expect(
        Promise.race([sleeper.then(() => "done"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await expect(sleeper).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects if the signal aborts during listener registration", async () => {
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      get reason() {
        return new Error("listener-registration-race");
      },
      addEventListener(_event: string, _listener: EventListenerOrEventListenerObject) {
        aborted = true;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;

    await expect(sleepWithAbort(50, signal)).rejects.toMatchObject({
      message: "aborted",
    });
  });
});
