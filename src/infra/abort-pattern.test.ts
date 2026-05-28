import { describe, expect, it, vi } from "vitest";
import { bindAbortRelay } from "../utils/fetch-timeout.js";

/**
 * Regression test for #7174: Memory leak from closure-wrapped controller.abort().
 *
 * Using `() => controller.abort()` creates a closure that captures the
 * surrounding lexical scope (controller, timer, locals).  In long-running
 * processes these closures accumulate and prevent GC.
 *
 * The fix uses two patterns:
 * - setTimeout: `controller.abort.bind(controller)` (safe, no args passed)
 * - addEventListener: `bindAbortRelay(controller)` which returns a bound
 *   function that ignores the Event argument, preserving the default
 *   AbortError reason.
 */

describe("abort pattern: .bind() vs arrow closure (#7174)", () => {
  function expectDefaultAbortReason(controller: AbortController): void {
    expect(controller.signal.reason).toBeInstanceOf(DOMException);
    expect(controller.signal.reason.name).toBe("AbortError");
  }

  it("controller.abort.bind(controller) aborts the signal", () => {
    const controller = new AbortController();
    const boundAbort = controller.abort.bind(controller);
    expect(controller.signal.aborted).toBe(false);
    boundAbort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("bound abort works with setTimeout", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const timer = setTimeout(controller.abort.bind(controller), 10);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect(controller.signal.aborted).toBe(true);
      clearTimeout(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bindAbortRelay() preserves default AbortError reason when used as event listener", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const onAbort = bindAbortRelay(child);

    parent.signal.addEventListener("abort", onAbort, { once: true });
    parent.abort();

    expect(child.signal.aborted).toBe(true);
    expectDefaultAbortReason(child);
  });

  it("raw .abort.bind() leaks Event as reason — bindAbortRelay() does not", () => {
    // Demonstrates the bug: .abort.bind() passes the Event as abort reason
    const parentA = new AbortController();
    const childA = new AbortController();
    parentA.signal.addEventListener("abort", childA.abort.bind(childA), { once: true });
    parentA.abort();
    // childA.signal.reason is the Event, NOT an AbortError
    expect(childA.signal.reason).not.toBeInstanceOf(DOMException);

    // The fix: bindAbortRelay() ignores the Event argument
    const parentB = new AbortController();
    const childB = new AbortController();
    parentB.signal.addEventListener("abort", bindAbortRelay(childB), { once: true });
    parentB.abort();
    expectDefaultAbortReason(childB);
  });

  it("removeEventListener works with saved bindAbortRelay() reference", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const onAbort = bindAbortRelay(child);

    parent.signal.addEventListener("abort", onAbort);
    parent.signal.removeEventListener("abort", onAbort);
    parent.abort();
    expect(child.signal.aborted).toBe(false);
  });

  it("bindAbortRelay() forwards abort through combined signals", () => {
    // Simulates the combineAbortSignals pattern from agent-tools.abort.ts
    const signalA = new AbortController();
    const signalB = new AbortController();
    const combined = new AbortController();

    const onAbort = bindAbortRelay(combined);
    signalA.signal.addEventListener("abort", onAbort, { once: true });
    signalB.signal.addEventListener("abort", onAbort, { once: true });

    expect(combined.signal.aborted).toBe(false);
    signalA.abort();
    expect(combined.signal.aborted).toBe(true);
    expectDefaultAbortReason(combined);
  });
});
