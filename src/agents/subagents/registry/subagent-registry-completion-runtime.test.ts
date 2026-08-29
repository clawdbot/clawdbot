import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRunRecord(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent-${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test task",
    cleanup: "delete",
    createdAt: 0,
    execution: {
      status: "terminal",
      endedAt: 1_000,
      outcome: { status: "error", error: "boom" },
    },
  };
}

describe("createSubagentRegistryCompletionRuntime background completion", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lands background completion failures in the log instead of escaping the detached call", async () => {
    vi.useFakeTimers();
    const runs = new Map<string, SubagentRunRecord>([["run-1", createRunRecord("run-1")]]);
    const warn = vi.fn();
    const runtime = createSubagentRegistryCompletionRuntime({
      runs,
      resumed: new Set<string>(),
      retryTimers: new Set<ReturnType<typeof setTimeout>>(),
      // Both attempts fail, so the attempt callback reaches the resume path.
      completeSubagentRun: vi.fn().mockRejectedValue(new Error("persist exploded")),
      scheduleSweep: vi.fn(),
      resumeRun: vi.fn(() => {
        throw new Error("resume exploded");
      }),
      warn,
    });

    runtime.pendingLifecycle.scheduleError({ runId: "run-1", endedAt: 900, error: "boom" });
    await vi.advanceTimersByTimeAsync(AGENT_RUN_TERMINAL_RETRY_GRACE_MS);

    // The detached boundary reports the escaped error; before the fix the
    // recovery wrapper's rethrow surfaced as an unhandled rejection on the
    // process-level fatal path and no warning was recorded at all.
    expect(warn).toHaveBeenCalledWith(
      "failed to complete subagent run in background",
      expect.objectContaining({ source: "lifecycle-error-grace", runId: "run-1" }),
    );
  });

  it("keeps the restart-retry discriminator when a delayed retry fails in the detached boundary", async () => {
    vi.useFakeTimers();
    const entry = createRunRecord("run-1");
    const runs = new Map<string, SubagentRunRecord>([["run-1", entry]]);
    const warn = vi.fn();
    const runtime = createSubagentRegistryCompletionRuntime({
      runs,
      resumed: new Set<string>(),
      retryTimers: new Set<ReturnType<typeof setTimeout>>(),
      // Both attempts fail, so the attempt callback reaches the resume path.
      completeSubagentRun: vi.fn().mockRejectedValue(new Error("persist exploded")),
      scheduleSweep: vi.fn(),
      resumeRun: vi.fn(() => {
        throw new Error("resume exploded");
      }),
      warn,
    });

    runtime.scheduleSubagentCompletionRetryAfterRestart(
      {
        runId: "run-1",
        expectedEntry: entry,
        endedAt: 1_000,
        outcome: { status: "error", error: "boom" },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: true,
      },
      "explicit-failed-mark",
      entry,
    );
    await vi.advanceTimersByTimeAsync(1_100);

    // The delayed retry reuses the shared detached boundary, so its failure
    // must still name the restart recovery instead of reading as an initial
    // background completion loss.
    expect(warn).toHaveBeenCalledWith(
      "failed to retry subagent completion after gateway restart",
      expect.objectContaining({ source: "explicit-failed-mark", runId: "run-1" }),
    );
  });
});
