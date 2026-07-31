// Codex tests cover attempt turn watches plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateActiveCompletionBlockerItemIds } from "./attempt-notifications.js";
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
    let activeCompletionBlockers = 0;
    let activeFinalizationHooks = 0;
    let canReleaseAssistantCompletionIdle = true;
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
      getActiveCompletionBlockerItemCount: () => activeCompletionBlockers,
      getActiveFinalizationHookCount: () => activeFinalizationHooks,
      canReleaseAssistantCompletionIdle: () => canReleaseAssistantCompletionIdle,
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
      set activeCompletionBlockers(value: number) {
        activeCompletionBlockers = value;
      },
      set activeFinalizationHooks(value: number) {
        activeFinalizationHooks = value;
      },
      set canReleaseAssistantCompletionIdle(value: boolean) {
        canReleaseAssistantCompletionIdle = value;
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

  it("keeps terminal idle gated while an app-server request is in flight", () => {
    const harness = createController();
    harness.activeRequests = 1;

    harness.controller.armTerminalIdleWatch();
    vi.advanceTimersByTime(10);

    expect(harness.timeouts).toEqual([]);
    expect(harness.abortController.signal.aborted).toBe(false);
  });

  it("fires terminal idle after the in-flight request settles and silence resumes", () => {
    const harness = createController();
    harness.activeRequests = 1;

    harness.controller.armTerminalIdleWatch();
    vi.advanceTimersByTime(10);
    expect(harness.timeouts).toEqual([]);

    harness.activeRequests = 0;
    harness.controller.touchActivity("request:item/tool/call:response");
    vi.advanceTimersByTime(9);
    expect(harness.timeouts).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(harness.timeouts).toMatchObject([
      {
        kind: "terminal",
        idleMs: 10,
        timeoutMs: 10,
        lastActivityReason: "request:item/tool/call:response",
      },
    ]);
    expect(harness.abortController.signal.reason).toBe("turn_terminal_idle_timeout");
  });

  it("keeps completion idle gated while a request is in flight", () => {
    const harness = createController();
    harness.activeRequests = 1;

    harness.controller.touchActivity("turn:start", { arm: true });
    vi.advanceTimersByTime(10);

    expect(harness.timeouts).toEqual([]);
    expect(harness.abortController.signal.aborted).toBe(false);

    harness.activeRequests = 0;
    harness.controller.scheduleProgressWatches();
    vi.advanceTimersByTime(1);

    expect(harness.timeouts).toMatchObject([{ kind: "completion" }]);
  });

  it("keeps assistant-completion gated while a request is in flight", () => {
    const harness = createController();
    harness.activeRequests = 1;

    harness.controller.armAssistantCompletionIdleWatch();
    vi.advanceTimersByTime(10);

    expect(harness.completed).toBe(false);
    expect(harness.abortController.signal.aborted).toBe(false);

    harness.activeRequests = 0;
    vi.advanceTimersByTime(1);

    expect(harness.completed).toBe(true);
  });

  it("waits for active completion blocker items before firing completion idle timeout", () => {
    const harness = createController();
    harness.activeCompletionBlockers = 1;

    harness.controller.touchActivity("request:mcpServer/elicitation/request:response", {
      arm: true,
    });
    vi.advanceTimersByTime(10);

    expect(harness.timeouts).toEqual([]);
    expect(harness.abortController.signal.aborted).toBe(false);

    harness.activeCompletionBlockers = 0;
    harness.controller.touchActivity("notification:item/completed");
    vi.advanceTimersByTime(10);

    expect(harness.timeouts).toMatchObject([
      {
        kind: "completion",
        idleMs: 10,
        timeoutMs: 10,
        lastActivityReason: "notification:item/completed",
      },
    ]);
  });

  it("releases a completed assistant item after the assistant idle guard expires", () => {
    const harness = createController();

    harness.controller.armAssistantCompletionIdleWatch({ method: "item/completed" });
    vi.advanceTimersByTime(10);

    expect(harness.completed).toBe(true);
    expect(harness.interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1", timeoutMs: 5 }]);
    expect(harness.events[0]?.name).toBe("turn.assistant_completion_idle_release");
  });

  it("does not release when a later completed item supersedes the assistant", () => {
    const harness = createController();

    harness.controller.armAssistantCompletionIdleWatch({ method: "item/completed" });
    harness.canReleaseAssistantCompletionIdle = false;
    vi.advanceTimersByTime(10);

    expect(harness.completed).toBe(false);
    expect(harness.controller.isAssistantCompletionIdleWatchArmed()).toBe(false);
    expect(harness.interrupts).toEqual([]);
    expect(harness.events).toEqual([]);
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

  it("waits for active finalization hooks before assistant idle release", () => {
    const harness = createController();

    harness.controller.armAssistantCompletionIdleWatch();
    harness.activeFinalizationHooks = 1;
    vi.advanceTimersByTime(10);

    expect(harness.completed).toBe(false);
    expect(harness.interrupts).toEqual([]);

    harness.activeFinalizationHooks = 0;
    harness.controller.armAssistantCompletionIdleWatch();
    vi.advanceTimersByTime(10);

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

describe("Codex completion blocker item tracking", () => {
  it.each([
    "collabAgentToolCall",
    "commandExecution",
    "dynamicToolCall",
    "fileChange",
    "imageGeneration",
    "imageView",
    "mcpToolCall",
    "webSearch",
  ])("tracks the %s lifecycle", (type) => {
    const activeItemIds = new Set<string>();
    updateActiveCompletionBlockerItemIds(
      { method: "item/started", params: { item: { id: "item-1", type } } },
      activeItemIds,
    );
    expect(activeItemIds).toEqual(new Set(["item-1"]));

    updateActiveCompletionBlockerItemIds(
      { method: "item/completed", params: { item: { id: "item-1", type } } },
      activeItemIds,
    );
    expect(activeItemIds).toEqual(new Set());
  });

  it.each(["agentMessage", "contextCompaction", "plan", "reasoning", "subAgentActivity"])(
    "does not track the %s lifecycle",
    (type) => {
      const activeItemIds = new Set<string>();
      updateActiveCompletionBlockerItemIds(
        { method: "item/started", params: { item: { id: "item-1", type } } },
        activeItemIds,
      );
      expect(activeItemIds).toEqual(new Set());
    },
  );
});
