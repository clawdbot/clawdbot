// Sleep utility tests cover timer-safe delay clamping and abort-listener cleanup
// for long-running agent waits.
import { describe, expect, it, vi } from "vitest";
import { isAbortError } from "../../infra/abort-signal.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import { sleep } from "./sleep.js";

describe("agents sleep", () => {
  it("rejects a pre-aborted zero-duration wait with the canonical abort error", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    const error = await sleep(0, controller.signal).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError", message: "aborted", cause: reason });
    expect(isAbortError(error)).toBe(true);
  });

  it("rejects a pre-aborted positive-duration wait", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(sleep(1, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "aborted",
      cause: reason,
    });
  });

  it("resolves a non-aborted zero-duration wait", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(sleep(0, new AbortController().signal)).resolves.toBeUndefined();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

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

  it("rejects cancellation with the canonical abort classification and cause", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const sleeper = sleep(60_000, controller.signal);

    controller.abort(reason);

    const error = await sleeper.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "AbortError", message: "aborted", cause: reason });
    expect(isAbortError(error)).toBe(true);
  });
});
