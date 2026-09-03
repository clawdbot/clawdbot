import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

function createHarness() {
  const entry: SubagentRunRecord = {
    runId: "completion-test",
    generation: 1,
    childSessionKey: "agent:main:subagent:completion-test",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "complete the synthetic task",
    cleanup: "keep",
    createdAt: 0,
    execution: { status: "terminal", endedAt: 1, outcome: { status: "error", error: "failed" } },
    cleanupHandled: true,
  };
  const runs = new Map([[entry.runId, entry]]);
  const resumed = new Set([entry.runId]);
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const resumeError = new Error("synthetic resume failure");
  const completeSubagentRun = vi
    .fn<(_: SubagentCompletionRequest) => Promise<void>>()
    .mockRejectedValue(new Error("synthetic completion failure"));
  const resumeRun = vi.fn(() => {
    throw resumeError;
  });
  const scheduleSweep = vi.fn();
  const warn = vi.fn();
  const runtime = createSubagentRegistryCompletionRuntime({
    runs,
    resumed,
    retryTimers,
    completeSubagentRun,
    resumeRun,
    scheduleSweep,
    warn,
  });
  const request: SubagentCompletionRequest = {
    runId: entry.runId,
    expectedEntry: entry,
    endedAt: 1,
    outcome: { status: "error", error: "failed" },
    reason: SUBAGENT_ENDED_REASON_ERROR,
    triggerCleanup: true,
  };
  return {
    entry,
    runs,
    resumed,
    retryTimers,
    resumeError,
    completeSubagentRun,
    resumeRun,
    scheduleSweep,
    warn,
    runtime,
    request,
  };
}

describe("subagent completion rejection ownership", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  it.each([
    { kind: "error", reason: SUBAGENT_ENDED_REASON_ERROR },
    { kind: "timeout", reason: SUBAGENT_ENDED_REASON_COMPLETE },
    { kind: "cancellation", reason: SUBAGENT_ENDED_REASON_KILLED },
  ] as const)("contains the $kind grace callback's escaped rejection", async ({ kind, reason }) => {
    const h = createHarness();
    const schedule =
      kind === "error"
        ? h.runtime.pendingLifecycle.scheduleError
        : kind === "timeout"
          ? h.runtime.pendingLifecycle.scheduleTimeout
          : h.runtime.pendingLifecycle.scheduleCancellation;
    schedule({ runId: h.entry.runId, endedAt: 1, error: "failed" });
    await vi.advanceTimersByTimeAsync(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
    expect(h.completeSubagentRun).toHaveBeenCalledTimes(2);
    expect(h.completeSubagentRun).toHaveBeenLastCalledWith(expect.objectContaining({ reason }));
    expect(h.resumeRun).toHaveBeenCalledExactlyOnceWith(h.entry.runId);
    expect(h.warn).toHaveBeenLastCalledWith("failed to complete subagent run in background", {
      source: `lifecycle-${kind}-grace`,
      runId: h.entry.runId,
      error: h.resumeError,
    });
    expect(h.runs.get(h.entry.runId)).toBe(h.entry);
    expect(h.entry.cleanupHandled).toBe(false);
    expect(h.resumed.has(h.entry.runId)).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("propagates the same escaped error to an awaited caller", async () => {
    const h = createHarness();
    await expect(
      h.runtime.completeSubagentRunWithRecovery(h.request, "subagent-wait"),
    ).rejects.toBe(h.resumeError);
    expect(h.completeSubagentRun).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("retains the restart-retry diagnostic and retires the fired timer", async () => {
    const h = createHarness();
    h.runtime.scheduleSubagentCompletionRetryAfterRestart(
      h.request,
      "explicit-failed-mark",
      h.entry,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.warn).toHaveBeenLastCalledWith(
      "failed to retry subagent completion after gateway restart",
      {
        source: "explicit-failed-mark",
        runId: h.entry.runId,
        error: h.resumeError,
      },
    );
    expect(h.completeSubagentRun).toHaveBeenCalledTimes(2);
    expect(h.retryTimers.size).toBe(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["replacement", "generation"] as const)(
    "rejects a stale restart timer after %s",
    async (change) => {
      const h = createHarness();
      h.runtime.scheduleSubagentCompletionRetryAfterRestart(h.request, "restart", h.entry);
      if (change === "replacement") {
        h.runs.set(h.entry.runId, { ...h.entry });
      } else {
        h.entry.generation = 2;
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.completeSubagentRun).not.toHaveBeenCalled();
      expect(h.retryTimers.size).toBe(0);
    },
  );

  it.each([1, 2])(
    "stops after successful attempt %i without starting cleanup recovery",
    async (attempt) => {
      const h = createHarness();
      h.completeSubagentRun.mockReset();
      if (attempt === 2) {
        h.completeSubagentRun.mockRejectedValueOnce(new Error("retry once"));
      }
      h.completeSubagentRun.mockResolvedValue(undefined);
      await h.runtime.completeSubagentRunWithRecovery(h.request, "subagent-wait");
      expect(h.completeSubagentRun).toHaveBeenCalledTimes(attempt);
      expect(h.resumeRun).not.toHaveBeenCalled();
      expect(h.scheduleSweep).not.toHaveBeenCalled();
    },
  );

  it("stops retrying when the failed attempt removes the row", async () => {
    const h = createHarness();
    h.completeSubagentRun.mockImplementation(async () => {
      h.runs.delete(h.entry.runId);
      throw new Error("row retired during completion");
    });
    await h.runtime.completeSubagentRunWithRecovery(h.request, "subagent-wait");
    expect(h.completeSubagentRun).toHaveBeenCalledOnce();
    expect(h.resumeRun).not.toHaveBeenCalled();
    expect(h.scheduleSweep).not.toHaveBeenCalled();
  });

  it.each(["running", "cleaned", "yielded"] as const)(
    "preserves %s recovery after both attempts fail",
    async (state) => {
      const h = createHarness();
      if (state === "running") {
        h.entry.execution = { status: "running", startedAt: 0 };
      }
      if (state === "cleaned") {
        h.entry.cleanupCompletedAt = 2;
      }
      if (state === "yielded") {
        h.entry.pauseReason = "sessions_yield";
      }
      await h.runtime.completeSubagentRunWithRecovery(h.request, "subagent-wait");
      expect(h.completeSubagentRun).toHaveBeenCalledTimes(2);
      expect(h.resumeRun).not.toHaveBeenCalled();
      expect(h.entry.cleanupHandled).toBe(true);
      expect(h.resumed.has(h.entry.runId)).toBe(true);
      if (state === "running") {
        expect(h.scheduleSweep).toHaveBeenCalledExactlyOnceWith({ delayMs: 1_000 });
      } else {
        expect(h.scheduleSweep).not.toHaveBeenCalled();
      }
    },
  );
});
