// Coverage for attempt timeout ownership and cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedAttemptRunAbort } from "./attempt-abort.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

function createTimeoutHarness(options?: {
  activeCompaction?: boolean;
  pendingCompaction?: boolean;
  timeoutMs?: number;
}) {
  const state = {
    activeCompaction: options?.activeCompaction ?? false,
    pendingCompaction: options?.pendingCompaction ?? false,
    streaming: false,
  };
  const abortController = new AbortController();
  const abortRun = vi.fn();
  const markExternalAbort = vi.fn();
  const markTimedOutDuringCompaction = vi.fn();
  const markTimedOutByRunBudget = vi.fn();
  const onAttemptTimeoutArmed = vi.fn();
  const timeout = prepareEmbeddedAttemptTimeout({
    attempt: {
      runId: "run-1",
      sessionId: "session-1",
      timeoutMs: options?.timeoutMs ?? 100,
      abortSignal: abortController.signal,
      onAttemptTimeoutArmed,
    },
    activeSession: {
      get isCompacting() {
        return state.activeCompaction;
      },
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
    markExternalAbort,
    markTimedOutDuringCompaction,
    markTimedOutByRunBudget,
  });
  return {
    abortController,
    abortRun,
    markExternalAbort,
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
    harness.timeout.clearTimers();
  });

  it("preserves the built-in deadline reason through a late prompt handoff", async () => {
    const sessionLockController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: vi.fn(async () => ({ release: async () => undefined })),
      lockOptions: { sessionFile: "agent:main:main" },
    });
    const runAbortController = new AbortController();
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession: vi.fn(async () => {}),
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt: {
        runId: "run-deadline-handoff",
        sessionFile: "agent:main:main",
        sessionId: "session-deadline-handoff",
        sessionKey: "agent:main:main",
      },
      getQueueHandle: () => undefined,
      isProbeSession: true,
      log: { warn: vi.fn() },
      runAbortController,
      sessionLockController,
      state: {
        markAborted: vi.fn(),
        markTimedOut: vi.fn(),
        markTimedOutDuringToolExecution: vi.fn(),
        readTimedOutDuringCompaction: () => false,
      },
    });
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt: {
        runId: "run-deadline-handoff",
        sessionId: "session-deadline-handoff",
        timeoutMs: 100,
      },
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 50,
      isProbeSession: true,
      abortRun,
      markExternalAbort: vi.fn(),
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(100);

    const timeoutReason = runAbortController.signal.reason;
    expect(timeoutReason).toEqual(
      expect.objectContaining({ name: "TimeoutError", message: "request timed out" }),
    );
    await expect(sessionLockController.releaseForPrompt()).rejects.toBe(timeoutReason);
    timeout.clearTimers();
    await sessionLockController.dispose();
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

  it("classifies an external timeout during compaction", () => {
    const harness = createTimeoutHarness({ activeCompaction: true });
    const reason = new Error("request timed out");
    reason.name = "TimeoutError";

    harness.abortController.abort(reason);

    expect(harness.markExternalAbort).toHaveBeenCalledOnce();
    expect(harness.markTimedOutDuringCompaction).toHaveBeenCalledOnce();
    expect(harness.abortRun).toHaveBeenCalledWith(true, reason);
    harness.timeout.clearTimers();
  });

  it("cleans up both the timer and external abort listener", async () => {
    const harness = createTimeoutHarness();

    harness.timeout.clearTimers();
    harness.timeout.removeAbortSignalListener();
    harness.abortController.abort(new Error("late abort"));
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.markExternalAbort).not.toHaveBeenCalled();
    expect(harness.markTimedOutByRunBudget).not.toHaveBeenCalled();
    expect(harness.abortRun).not.toHaveBeenCalled();
  });
});
