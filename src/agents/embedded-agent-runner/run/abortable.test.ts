// Coverage for abort-aware promise wrapping in embedded attempts.
import { describe, expect, it, vi } from "vitest";
import {
  abortable,
  joinWithRunLivenessDeadline,
  RUN_LIVENESS_JOIN_TIMEOUT_MS,
} from "./abortable.js";

describe("abortable", () => {
  it("rejects with AbortError when signal aborts before inner settles", async () => {
    // The inner promise may never settle during provider/tool cancellation, so
    // abortable must reject from the signal alone.
    const ac = new AbortController();
    const inner = new Promise<void>(() => {});
    const wrapped = abortable(ac.signal, inner);
    ac.abort();
    try {
      await wrapped;
      expect.fail("expected rejection");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("rejects immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const inner = new Promise<void>(() => {});
    await expect(abortable(ac.signal, inner)).rejects.toThrow(/aborted/i);
  });

  it("resolves with inner value when inner settles before abort", async () => {
    const ac = new AbortController();
    await expect(abortable(ac.signal, Promise.resolve(42))).resolves.toBe(42);
  });
});

describe("joinWithRunLivenessDeadline", () => {
  it("resolves when the joined work settles, without firing onTimeout", async () => {
    const ac = new AbortController();
    const onTimeout = vi.fn();
    await joinWithRunLivenessDeadline({
      joinWork: () => Promise.resolve(),
      runAbortSignal: ac.signal,
      onTimeout,
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("resolves at the liveness deadline when the joined work hangs", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const onTimeout = vi.fn();
      const join = joinWithRunLivenessDeadline({
        joinWork: () => new Promise<never>(() => {}),
        runAbortSignal: ac.signal,
        onTimeout,
      });
      await vi.advanceTimersByTimeAsync(RUN_LIVENESS_JOIN_TIMEOUT_MS);
      await join;
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves immediately on an aborted run signal and treats rejection as settled", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const onTimeout = vi.fn();
    await joinWithRunLivenessDeadline({
      joinWork: () => new Promise<never>(() => {}),
      runAbortSignal: aborted.signal,
      onTimeout,
    });
    const ac = new AbortController();
    await joinWithRunLivenessDeadline({
      joinWork: () => Promise.reject(new Error("delivery chain error already logged")),
      runAbortSignal: ac.signal,
      onTimeout,
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
