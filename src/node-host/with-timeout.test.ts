/** Tests node-host timeout handling, abort reasons, and cleanup behavior. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAbortableTimeout } from "./with-timeout.js";

describe("runAbortableTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("names the operation pending when the deadline fires", async () => {
    vi.useFakeTimers();
    let stage = "queued";
    let signal: AbortSignal | undefined;
    let reportProgress!: () => void;
    const pending = runAbortableTimeout(
      (timeoutSignal, resetTimeout) => {
        signal = timeoutSignal;
        reportProgress = resetTimeout;
        return new Promise<never>(() => {});
      },
      30,
      () => `publication: ${stage}`,
    );
    const result = Promise.allSettled([pending]);
    stage = "credentials";
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toEqual([
      { status: "rejected", reason: new Error("publication: credentials timed out") },
    ]);
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toBe(signal?.reason);
    reportProgress();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps huge finite timeoutMs before scheduling the timer", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      runAbortableTimeout(async (signal) => {
        expect(signal?.aborted).toBe(false);
        return "ok";
      }, Number.MAX_SAFE_INTEGER),
    ).resolves.toBe("ok");

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("restarts the timeout window when work reports progress", async () => {
    vi.useFakeTimers();
    const pending = runAbortableTimeout(async (_signal, resetTimeout) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      resetTimeout();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      return "ok";
    }, 30);

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});
