// Coverage for attempt timeout ownership and cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedAttemptRunAbort } from "./attempt-finalize.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";

function createTimeoutHarness(options?: { pendingCompaction?: boolean; timeoutMs?: number }) {
  const state = {
    pendingCompaction: options?.pendingCompaction ?? false,
    streaming: false,
  };
  const abortRun = vi.fn();
  const markTimedOutDuringCompaction = vi.fn();
  const markTimedOutByRunBudget = vi.fn();
  const onAttemptTimeoutArmed = vi.fn();
  const timeout = prepareEmbeddedAttemptTimeout({
    attempt: {
      runId: "run-1",
      sessionId: "session-1",
      timeoutMs: options?.timeoutMs ?? 100,
      onAttemptTimeoutArmed,
    },
    activeSession: {
      isCompacting: false,
      get isStreaming() {
        return state.streaming;
      },
    },
    compactionState: {
      isCompacting: () => state.pendingCompaction,
    },
    compactionTimeoutMs: 50,
    isProbeSession: true,
    abortRun,
    markTimedOutDuringCompaction,
    markTimedOutByRunBudget,
  });
  return {
    abortRun,
    markTimedOutDuringCompaction,
    markTimedOutByRunBudget,
    onAttemptTimeoutArmed,
    state,
    timeout,
  };
}

describe("prepareEmbeddedAttemptTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms and fires the run budget timeout", async () => {
    const harness = createTimeoutHarness();

    expect(harness.onAttemptTimeoutArmed).toHaveBeenCalledOnce();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.markTimedOutByRunBudget).toHaveBeenCalledOnce();
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    // The run-budget marker must be recorded before the abort so settlement
    // can re-confirm terminal ownership before committing partial output; the
    // timeout callback itself never commits buffered text.
    const markOrder = harness.markTimedOutByRunBudget.mock.invocationCallOrder[0];
    const abortOrder = harness.abortRun.mock.invocationCallOrder[0];
    expect(markOrder).toBeDefined();
    expect(abortOrder).toBeDefined();
    expect(markOrder ?? -1).toBeLessThan(abortOrder ?? -1);
    harness.timeout.clearTimers();
  });

  it("propagates the built-in deadline reason", async () => {
    const runAbortController = new AbortController();
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession: vi.fn(async () => {}),
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt: {
        runId: "run-deadline",
        sessionFile: "agent:main:main",
        sessionId: "session-deadline",
        sessionKey: "agent:main:main",
      },
      getQueueHandle: () => undefined,
      isProbeSession: true,
      log: { warn: vi.fn() },
      runAbortController,
      state: {
        markAborted: vi.fn(),
        markTimedOut: vi.fn(),
        markTimedOutDuringToolExecution: vi.fn(),
        readTimedOutDuringCompaction: () => false,
      },
    });
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt: {
        runId: "run-deadline",
        sessionId: "session-deadline",
        timeoutMs: 100,
      },
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 50,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(runAbortController.signal.reason).toEqual(
      expect.objectContaining({ name: "TimeoutError", message: "request timed out" }),
    );
    timeout.clearTimers();
  });

  it("grants one compaction grace window before aborting", async () => {
    const harness = createTimeoutHarness({ pendingCompaction: true });

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(150);

    harness.state.pendingCompaction = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("cleans up the run budget timer", async () => {
    const harness = createTimeoutHarness();

    harness.timeout.clearTimers();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.markTimedOutByRunBudget).not.toHaveBeenCalled();
    expect(harness.abortRun).not.toHaveBeenCalled();
  });
});
