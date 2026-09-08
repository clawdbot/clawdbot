// Coverage for attempt timeout ownership and cleanup.
import { getEventListeners } from "node:events";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { createEmbeddedAttemptRunAbort } from "./attempt-finalize.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type DeadlineChanged = NonNullable<EmbeddedRunAttemptParams["onAttemptDeadlineChanged"]>;
const timeoutCleanups: Array<() => void> = [];

function emitApproval(
  phase: "waiting-approval" | "approval-resolved",
  approvalId: string,
  runId = "run-1",
  sessionId = "session-1",
) {
  emitAgentEvent({ runId, sessionId, stream: "lifecycle", data: { phase, approvalId } });
}

function createTimeoutHarness(options?: {
  pendingCompaction?: boolean;
  compactionInFlight?: boolean;
  timeoutMs?: number;
  runAbortController?: AbortController;
  onDeadline?: DeadlineChanged;
}) {
  const state = {
    pendingCompaction: options?.pendingCompaction ?? false,
    compactionInFlight: options?.compactionInFlight ?? false,
    streaming: false,
  };
  const runAbortController = options?.runAbortController ?? new AbortController();
  const abortRun = vi.fn();
  const markTimedOutDuringCompaction = vi.fn();
  const markTimedOutByRunBudget = vi.fn();
  const onAttemptTimeoutArmed = vi.fn();
  const onAttemptDeadlineChanged = vi.fn<DeadlineChanged>(options?.onDeadline);
  const input = {
    attempt: {
      runId: "run-1",
      sessionId: "session-1",
      timeoutMs: options?.timeoutMs ?? 100,
      onAttemptTimeoutArmed,
      onAttemptDeadlineChanged,
    },
    runAbortSignal: runAbortController.signal,
    activeSession: {
      get isCompacting() {
        return state.compactionInFlight;
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
    markTimedOutDuringCompaction,
    markTimedOutByRunBudget,
  };
  const timeout = prepareEmbeddedAttemptTimeout(input);
  timeoutCleanups.push(timeout.clearTimers);
  return {
    abortRun,
    markTimedOutDuringCompaction,
    markTimedOutByRunBudget,
    onAttemptTimeoutArmed,
    onAttemptDeadlineChanged,
    runAbortController,
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
    for (const cleanup of timeoutCleanups.splice(0)) {
      cleanup();
    }
    vi.useRealTimers();
  });

  it("publishes the exact execution deadline before firing the run budget timeout", async () => {
    const harness = createTimeoutHarness();

    expect(harness.onAttemptTimeoutArmed).toHaveBeenCalledOnce();
    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([
      [{ kind: "bounded", deadlineAtMs: 100 }],
    ]);
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
      state: { terminal: { kind: "ok" } },
    });
    const input = {
      attempt: {
        runId: "run-deadline",
        sessionId: "session-deadline",
        timeoutMs: 100,
      },
      runAbortSignal: runAbortController.signal,
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 50,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    };
    const timeout = prepareEmbeddedAttemptTimeout(input);
    timeoutCleanups.push(timeout.clearTimers);

    await vi.advanceTimersByTimeAsync(100);

    expect(runAbortController.signal.reason).toEqual(
      expect.objectContaining({ name: "TimeoutError", message: "request timed out" }),
    );
    timeout.clearTimers();
  });

  it("pauses exactly the original run budget until all scoped approvals resolve", async () => {
    const harness = createTimeoutHarness();

    await vi.advanceTimersByTimeAsync(30);
    emitApproval("waiting-approval", "first");
    emitApproval("waiting-approval", "second");
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBeUndefined();
    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([
      [{ kind: "bounded", deadlineAtMs: 100 }],
      [{ kind: "unlimited" }],
    ]);

    emitApproval("approval-resolved", "first", "another-run");
    emitApproval("approval-resolved", "first", "run-1", "another-session");
    emitApproval("approval-resolved", "first");
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(harness.onAttemptDeadlineChanged).toHaveBeenCalledTimes(2);

    emitApproval("approval-resolved", "second");
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(700);
    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([
      [{ kind: "bounded", deadlineAtMs: 100 }],
      [{ kind: "unlimited" }],
      [{ kind: "bounded", deadlineAtMs: 700 }],
    ]);
    await vi.advanceTimersByTimeAsync(69);
    expect(harness.abortRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.markTimedOutByRunBudget).toHaveBeenCalledOnce();
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it("pauses only the unused compaction grace budget during inline approval", async () => {
    const harness = createTimeoutHarness({ pendingCompaction: true });
    await vi.advanceTimersByTimeAsync(120);
    emitApproval("waiting-approval", "grace");
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBeUndefined();

    harness.state.pendingCompaction = false;
    emitApproval("approval-resolved", "grace");
    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([
      [{ kind: "bounded", deadlineAtMs: 100 }],
      [{ kind: "bounded", deadlineAtMs: 150 }],
      [{ kind: "unlimited" }],
      [{ kind: "bounded", deadlineAtMs: 650 }],
    ]);
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(650);
    await vi.advanceTimersByTimeAsync(29);
    expect(harness.abortRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.abortRun).toHaveBeenCalledWith(true);
    harness.timeout.clearTimers();
  });

  it.each([
    { name: "pending", pendingCompaction: true },
    { name: "in-flight", compactionInFlight: true },
  ])("publishes only one grace deadline for $name compaction", async (options) => {
    const harness = createTimeoutHarness(options);

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBe(150);
    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([
      [{ kind: "bounded", deadlineAtMs: 100 }],
      [{ kind: "bounded", deadlineAtMs: 150 }],
    ]);

    await vi.advanceTimersByTimeAsync(50);
    expect(harness.markTimedOutDuringCompaction).toHaveBeenCalledOnce();
    expect(harness.abortRun).toHaveBeenCalledWith(true);
    expect(harness.onAttemptDeadlineChanged).toHaveBeenCalledTimes(2);
  });

  it("publishes an unlimited run without arming a timer or inventing a finite deadline", async () => {
    const harness = createTimeoutHarness({ timeoutMs: MAX_TIMER_TIMEOUT_MS });

    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([[{ kind: "unlimited" }]]);
    expect(harness.onAttemptTimeoutArmed).toHaveBeenCalledOnce();
    expect(harness.timeout.getRunAbortDeadlineAtMs()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    emitApproval("waiting-approval", "unlimited");
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS + 1);
    emitApproval("approval-resolved", "unlimited");

    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(harness.markTimedOutByRunBudget).not.toHaveBeenCalled();
    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([[{ kind: "unlimited" }]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([100, MAX_TIMER_TIMEOUT_MS])(
    "does not publish or arm a pre-aborted run with budget %i",
    async (timeoutMs) => {
      const runAbortController = new AbortController();
      runAbortController.abort(new Error("cancelled before timer preparation"));
      const harness = createTimeoutHarness({ timeoutMs, runAbortController });

      emitApproval("waiting-approval", "late");
      emitApproval("approval-resolved", "late");
      await vi.advanceTimersByTimeAsync(200);

      expect(harness.onAttemptDeadlineChanged).not.toHaveBeenCalled();
      expect(harness.onAttemptTimeoutArmed).not.toHaveBeenCalled();
      expect(harness.abortRun).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(runAbortController.signal, "abort")).toHaveLength(0);
    },
  );

  it.each(["running", "approval-paused", "compaction-grace"] as const)(
    "closes a %s deadline on local run abort without late approval resurrection",
    async (phase) => {
      const harness = createTimeoutHarness({ pendingCompaction: phase === "compaction-grace" });
      await vi.advanceTimersByTimeAsync(phase === "compaction-grace" ? 120 : 30);
      if (phase === "approval-paused") {
        emitApproval("waiting-approval", "pending");
      }
      const published = harness.onAttemptDeadlineChanged.mock.calls.slice();

      harness.runAbortController.abort(new Error("local run cancelled"));
      emitApproval("approval-resolved", "pending");
      emitApproval("waiting-approval", "late");
      emitApproval("approval-resolved", "late");
      await vi.advanceTimersByTimeAsync(200);

      expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual(published);
      expect(harness.markTimedOutByRunBudget).not.toHaveBeenCalled();
      expect(harness.abortRun).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(harness.runAbortController.signal, "abort")).toHaveLength(0);
    },
  );

  it("does not retain scheduling when deadline publication synchronously aborts the owner", async () => {
    const runAbortController = new AbortController();
    const harness = createTimeoutHarness({
      runAbortController,
      onDeadline: () => runAbortController.abort(new Error("owner closed during publication")),
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([
      [{ kind: "bounded", deadlineAtMs: 100 }],
    ]);
    expect(harness.onAttemptTimeoutArmed).not.toHaveBeenCalled();
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(runAbortController.signal, "abort")).toHaveLength(0);
  });

  it("does not resurrect timers or deadline publications during synchronous timeout cleanup", async () => {
    const harness = createTimeoutHarness();
    harness.abortRun.mockImplementation(() => {
      emitApproval("waiting-approval", "late");
      emitApproval("approval-resolved", "late");
      harness.timeout.clearTimers();
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(harness.abortRun).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual([
      [{ kind: "bounded", deadlineAtMs: 100 }],
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.abortRun).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cleans up the run deadline permanently (paused=%s)", async (paused) => {
    const harness = createTimeoutHarness();
    if (paused) {
      emitApproval("waiting-approval", "pending");
    }
    const published = harness.onAttemptDeadlineChanged.mock.calls.slice();

    harness.timeout.clearTimers();
    harness.timeout.clearTimers();
    emitApproval("approval-resolved", "pending");
    emitApproval("waiting-approval", "late");
    emitApproval("approval-resolved", "late");
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.onAttemptDeadlineChanged.mock.calls).toEqual(published);
    expect(harness.markTimedOutByRunBudget).not.toHaveBeenCalled();
    expect(harness.abortRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(harness.runAbortController.signal, "abort")).toHaveLength(0);
  });
});
