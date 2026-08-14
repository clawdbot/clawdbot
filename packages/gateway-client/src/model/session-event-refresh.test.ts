import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionEventRefreshCoordinator } from "./session-event-refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session event refresh coordinator", () => {
  it("coalesces bursts and runs one trailing refresh after failure", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      canRefresh: () => true,
      refresh,
    });

    coordinator.schedule();
    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(1);

    coordinator.schedule();
    await vi.advanceTimersByTimeAsync(200);
    first.reject(new Error("transient failure"));
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  it("retires pending work on reset", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createSessionEventRefreshCoordinator({
      canRefresh: () => true,
      refresh,
    });
    coordinator.schedule();
    coordinator.reset();
    await vi.runAllTimersAsync();
    expect(refresh).not.toHaveBeenCalled();
  });
});
