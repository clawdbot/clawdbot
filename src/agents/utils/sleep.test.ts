// Sleep utility tests cover timer-safe delay clamping and abort-listener cleanup
// for long-running agent waits.
import { describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import { sleep } from "./sleep.js";

describe("agents sleep", () => {
  it("clamps oversized delays before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const sleeper = sleep(Number.MAX_SAFE_INTEGER);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      await expect(sleeper).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("removes abort listeners after normal resolution", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const sleeper = sleep(5, controller.signal);

      await vi.advanceTimersByTimeAsync(5);
      await expect(sleeper).resolves.toBeUndefined();

      expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      removeListenerSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
