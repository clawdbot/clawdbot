// Codex tests cover attempt turn watches plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAttemptTurnWatchController } from "./attempt-turn-watches.js";

describe("Codex app-server attempt turn watches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function createController(
    overrides: Partial<Parameters<typeof createCodexAttemptTurnWatchController>[0]> = {},
  ) {
    const abortController = new AbortController();
    let completed = false;
    let terminalQueued = false;
    let activeRequests = 0;
    let activeItems = 0;
    const interrupts: Array<Record<string, unknown>> = [];
    const timeouts: Array<Record<string, unknown>> = [];
    const events: Array<{ name: string; fields: Record<string, unknown> }> = [];
    const progress: string[] = [];
    const diagnostics: string[] = [];
    const controller = createCodexAttemptTurnWatchController({
      threadId: "thread-1",
      signal: abortController.signal,
      getTurnId: () => "turn-1",
      isCompleted: () => completed,
      isTerminalTurnNotificationQueued: () => terminalQueued,
      getActiveAppServerTurnRequests: () => activeRequests,
      getActiveTurnItemCount: () => activeItems,
      turnCompletionIdleTimeoutMs: 10,
      turnAssistantCompletionIdleTimeoutMs: 10,
      turnAttemptIdleTimeoutMs: 10,
      turnTerminalIdleTimeoutMs: 10,
      interruptTimeoutMs: 5,
      onInterruptTurn: (input) => interrupts.push(input),
      onTimeout: (timeout) => timeouts.push(timeout),
      onMarkTimedOut: vi.fn(),
      onAbort: (reason) => abortController.abort(reason),
      onCompleted: () => {
        completed = true;
      },
      onResolveCompletion: vi.fn(),
      onRecordEvent: (name, fields) => events.push({ name, fields }),
      onAttemptProgress: (reason) => progress.push(reason),
      onProgressDiagnostic: (reason) => diagnostics.push(reason),
      ...overrides,
    });
    return {
      controller,
      abortController,
      get completed() {
        return completed;
      },
      set terminalQueued(value: boolean) {
        terminalQueued = value;
      },
      set activeRequests(value: number) {
        activeRequests = value;
      },
      set activeItems(value: number) {
        activeItems = value;
      },
      interrupts,
      timeouts,
      events,
      progress,
      diagnostics,
    };
  }

  it("fires completion idle timeout when an armed turn goes quiet", () => {
    const harness = createController();

    harness.controller.touchActivity("turn:start", { arm: true });
    vi.advanceTimersByTime(10);

    expect(harness.timeouts).toMatchObject([
      {
        kind: "completion",
        idleMs: 10,
        timeoutMs: 10,
        lastActivityReason: "turn:start",
        details: {
          activeAppServerTurnRequests: 0,
          activeTurnItemCount: 0,
          terminalTurnNotificationQueued: false,
          completionIdleWatchArmed: true,
          assistantCompletionIdleWatchArmed: false,
          terminalIdleWatchArmed: false,
        },
      },
    ]);
    expect(harness.abortController.signal.reason).toBe("turn_completion_idle_timeout");
  });

  it("prefers completion idle timeout when completion and progress watches are due together", () => {
    const harness = createController();

    harness.controller.armAttemptIdleWatch();
    harness.controller.touchActivity("request:item/tool/call:response", {
      arm: true,
      attemptProgress: true,
      attemptTimeoutMs: 10,
    });
    vi.advanceTimersByTime(10);

    expect(harness.timeouts).toMatchObject([
      {
        kind: "completion",
        idleMs: 10,
        timeoutMs: 10,
        lastActivityReason: "request:item/tool/call:response",
      },
    ]);
    expect(harness.abortController.signal.reason).toBe("turn_completion_idle_timeout");
  });

  it("clamps oversized completion idle timeouts before scheduling", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const harness = createController({
      turnCompletionIdleTimeoutMs: Number.MAX_SAFE_INTEGER,
    });

    harness.controller.touchActivity("turn:start", { arm: true });

    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("clamps oversized completion idle override timeouts before scheduling", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const harness = createController();

    harness.controller.armCompletionIdleWatch({ timeoutMs: Number.MAX_SAFE_INTEGER });

    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("does not fire completion idle timeout after terminal notification is queued", () => {
    const harness = createController();

    harness.controller.touchActivity("turn:start", { arm: true });
    harness.terminalQueued = true;
    vi.advanceTimersByTime(10);

    expect(harness.timeouts).toEqual([]);
    expect(harness.abortController.signal.aborted).toBe(false);
  });

  it("releases a completed assistant item after the assistant idle guard expires", () => {
    const harness = createController();

    harness.controller.armAssistantCompletionIdleWatch({ method: "item/completed" });
    vi.advanceTimersByTime(10);

    expect(harness.completed).toBe(true);
    expect(harness.interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1", timeoutMs: 5 }]);
    expect(harness.events[0]?.name).toBe("turn.assistant_completion_idle_release");
  });

  it("waits for active turn items before assistant idle release", () => {
    const harness = createController();
    harness.activeItems = 1;

    harness.controller.armAssistantCompletionIdleWatch();
    vi.advanceTimersByTime(10);
    expect(harness.completed).toBe(false);

    harness.activeItems = 0;
    vi.advanceTimersByTime(1);

    expect(harness.completed).toBe(true);
  });

  it("records attempt progress activity separately from completion-only activity", () => {
    const harness = createController();

    harness.controller.touchActivity("request:item/tool/call:start", {
      attemptProgress: true,
    });
    harness.controller.touchActivity("notification:item/completed");

    expect(harness.progress).toEqual(["request:item/tool/call:start"]);
    expect(harness.diagnostics).toEqual([
      "request:item/tool/call:start",
      "notification:item/completed",
    ]);
  });

  it("does not count receive-only notifications as attempt progress", () => {
    const harness = createController();

    harness.controller.armAttemptIdleWatch();
    vi.advanceTimersByTime(9);
    harness.controller.noteNotificationReceived("account/rateLimits/updated");
    vi.advanceTimersByTime(1);

    expect(harness.timeouts).toMatchObject([
      {
        kind: "progress",
        idleMs: 10,
        timeoutMs: 10,
        lastActivityReason: "startup",
      },
    ]);
    expect(harness.abortController.signal.reason).toBe("turn_progress_idle_timeout");
  });
});
