import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAttemptDeadlineController } from "./attempt-deadlines.js";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";

describe("Codex attempt deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function createController(timeoutMs = 60_000, startedAtMs = Date.now()) {
    const abort = new AbortController();
    const onTimeout = vi.fn();
    const onDeadlineChanged = vi.fn();
    const controller = createCodexAttemptDeadlineController({
      startedAtMs,
      timeoutMs,
      signal: abort.signal,
      onTimeout,
      onDeadlineChanged,
    });
    return { controller, abort, onTimeout, onDeadlineChanged };
  }

  it("expires the elapsed execution budget from attempt admission, not controller creation", () => {
    vi.setSystemTime(20_000);
    const { controller, onTimeout, onDeadlineChanged } = createController(60_000, 0);
    expect(controller.ownsExecutionWait()).toBe(true);
    expect(onDeadlineChanged).toHaveBeenCalledWith({ kind: "bounded", deadlineAtMs: 60_000 });

    vi.advanceTimersByTime(39_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "execution",
      elapsedMs: 60_000,
      timeoutMs: 60_000,
    });
    expect(controller.ownsExecutionWait()).toBe(false);
    controller.beginSettlement(Date.now());
    vi.advanceTimersByTime(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("stops claiming native liveness at expiry even before the timer callback runs", () => {
    const { controller, onTimeout } = createController();
    vi.setSystemTime(60_000);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("replaces execution with one absolute settlement deadline at native terminal receipt", () => {
    const { controller, onTimeout, onDeadlineChanged } = createController();
    vi.advanceTimersByTime(59_000);
    controller.beginSettlement(Date.now());
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onDeadlineChanged).toHaveBeenLastCalledWith({
      kind: "bounded",
      deadlineAtMs: 59_000 + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
    });

    vi.advanceTimersByTime(60_000);
    controller.beginSettlement(Date.now());
    vi.advanceTimersByTime(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "settlement",
      elapsedMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
    });
    expect(onDeadlineChanged).toHaveBeenCalledTimes(2);
  });

  it("charges time already spent behind a blocked projection against settlement", () => {
    const { controller, onTimeout } = createController(10 * 60_000);
    vi.advanceTimersByTime(90_000);
    controller.beginSettlement(30_000);
    vi.advanceTimersByTime(59_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "settlement",
      elapsedMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
    });
  });

  it("leaves normalized unlimited execution unbounded but still bounds local settlement", () => {
    const { controller, onTimeout, onDeadlineChanged } = createController(MAX_TIMER_TIMEOUT_MS);
    expect(onDeadlineChanged).toHaveBeenCalledExactlyOnceWith({ kind: "unlimited" });
    vi.advanceTimersByTime(49 * 60 * 60_000);
    expect(controller.ownsExecutionWait()).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();

    controller.beginSettlement(Date.now());
    expect(controller.ownsExecutionWait()).toBe(false);
    vi.advanceTimersByTime(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
      kind: "settlement",
      elapsedMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
    });
  });

  it.each(["abort", "dispose"] as const)("cannot revive a deadline after %s", (closure) => {
    const { controller, abort, onTimeout, onDeadlineChanged } = createController();
    controller.beginSettlement(Date.now());
    if (closure === "abort") {
      abort.abort("cancelled");
    } else {
      controller.dispose();
    }
    controller.beginSettlement(Date.now());
    vi.advanceTimersByTime(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS + 60_000);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDeadlineChanged).toHaveBeenCalledTimes(2);
  });

  it("does not schedule work for an already-aborted attempt", () => {
    const abort = new AbortController();
    abort.abort("cancelled");
    const onTimeout = vi.fn();
    const onDeadlineChanged = vi.fn();
    const controller = createCodexAttemptDeadlineController({
      startedAtMs: 0,
      timeoutMs: 60_000,
      signal: abort.signal,
      onTimeout,
      onDeadlineChanged,
    });
    controller.beginSettlement(0);
    vi.advanceTimersByTime(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
    expect(controller.ownsExecutionWait()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDeadlineChanged).not.toHaveBeenCalled();
  });
});
