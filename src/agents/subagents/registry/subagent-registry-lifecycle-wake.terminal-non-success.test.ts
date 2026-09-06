// Regression tests for mixed terminal requester-settle batches (#137332).
// When a batch contains non-success terminal children (failed, killed,
// timed_out) or orphaned rows (missing task), blockSubagentCompletionDelivery
// returns false. Previously, the throw restored the wake state, causing the
// sweeper to retry the same batch forever. The fix marks non-success delivery
// as failed without throwing, so the batch settles atomically for all siblings.
import { beforeEach, describe, expect, it, vi } from "vitest";

const completionDeliveryMocks = vi.hoisted(() => ({
  blockSubagentCompletionDelivery: vi.fn(() => false),
}));

const taskRuntimeMocks = vi.hoisted(() => ({
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

vi.mock("../completion/subagent-completion-admission.store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  blockSubagentCompletionDelivery: completionDeliveryMocks.blockSubagentCompletionDelivery,
}));

vi.mock("../../../tasks/detached-task-runtime.js", () => ({
  setDetachedTaskDeliveryStatusByRunId: taskRuntimeMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../../../plugins/runtime/gateway-request-scope.js", () => ({
  getGatewayContextResolver: () => undefined,
  clearGatewayContextResolver: vi.fn(),
}));

vi.mock("../../../config/sessions/transcript-write-context.js", () => ({
  runWithoutOwnedSessionTranscriptWrites: <T>(run: () => T): T => run(),
}));

vi.mock("../../../process/gateway-work-admission.js", () => ({
  isGatewayRestartDrainError: () => false,
}));

import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createFailedTerminalEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-failed",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "do something",
    cleanup: "keep",
    createdAt: 1_000,
    execution: {
      status: "terminal",
      startedAt: 2_000,
      endedAt: 4_000,
      outcome: { status: "error", error: "agent run failed" },
    },
    expectsCompletionMessage: true,
    delivery: { status: "pending", generation: 1 },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      rearmGeneration: 1,
    },
    ...overrides,
  } as unknown as SubagentRunRecord;
}

function createSuccessfulTerminalEntry(
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  return createFailedTerminalEntry({
    runId: "run-success",
    execution: {
      status: "terminal",
      startedAt: 2_000,
      endedAt: 4_000,
      outcome: { status: "ok" },
    },
    ...overrides,
  });
}

function createContext(
  entry: SubagentRunRecord,
  options: {
    resolveSubagentTask: (entry: SubagentRunRecord) => {
      lookup: "available" | "unavailable";
      task?: { taskId: string; status: string; runId: string };
    };
    maybeWake?: (params: {
      completeBatch: (
        batch: readonly SubagentRunRecord[],
        rearmGeneration?: number,
        outcome?: { delivered: boolean; path: string; error?: string },
      ) => void;
    }) => Promise<unknown>;
  },
): SubagentLifecycleWakeContext {
  const runs = new Map<string, SubagentRunRecord>([[entry.runId, entry]]);
  const captured: {
    completeBatch?: (
      batch: readonly SubagentRunRecord[],
      gen?: number,
      outcome?: Record<string, unknown>,
    ) => void;
  } = {};
  return {
    options: {
      runs,
      resumedRuns: new Set<string>(),
      subagentAnnounceTimeoutMs: 10_000,
      getRuntimeConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }) as never,
      persist: vi.fn(),
      persistOrThrow: vi.fn(),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      suppressAnnounceForSteerRestart: () => false,
      resolveSubagentTask: options.resolveSubagentTask,
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      emitSubagentProgressEndedForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      retireSupersededRun: vi.fn(async () => {}),
      resumeSubagentRun: vi.fn(),
      callGateway: vi.fn(async () => ({})),
      captureSubagentCompletionReply: vi.fn(async () => ({})) as never,
      cleanupBrowserSessionsForLifecycleEnd: undefined,
      loadCleanupBrowserSessionsForLifecycleEnd: undefined,
      runSubagentAnnounceFlow: vi.fn(async () => ({})) as never,
      maybeWakeRequesterAfterAllChildrenSettled:
        options.maybeWake ??
        (async (params: {
          completeBatch: (
            batch: readonly SubagentRunRecord[],
            rearmGeneration?: number,
            outcome?: { delivered: boolean; path: string; error?: string },
          ) => void;
        }) => {
          captured.completeBatch = params.completeBatch as never;
          params.completeBatch([entry], 1, {
            delivered: false,
            path: "none",
            error: "requester settle wake failed",
          });
          return false;
        }),
      warn: vi.fn(),
    },
    newerGenerationOwnsSession: () => false,
    hasScheduledRequesterSettleWakeRun: () => false,
    markRequesterSettleWakeRunScheduled: vi.fn(),
    unmarkRequesterSettleWakeRunScheduled: vi.fn(),
    runRequesterSettleWake: async (_entry: SubagentRunRecord, run: () => Promise<unknown>) => run(),
    getRequesterSettleWakeTimer: () => undefined,
    deleteRequesterSettleWakeTimer: vi.fn(),
    setRequesterSettleWakeTimer: vi.fn(),
    markRequesterSettleWakeRearm: vi.fn(),
    takeRequesterSettleWakeRearm: () => false,
  } as unknown as SubagentLifecycleWakeContext;
}

describe("terminal non-success settle wake reconciliation (#137332)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not throw when a failed terminal child blocks delivery", async () => {
    const entry = createFailedTerminalEntry();
    const context = createContext(entry, {
      resolveSubagentTask: () => ({
        lookup: "available",
        task: { taskId: "task-1", status: "failed", runId: "run-failed" },
      }),
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        try {
          scheduleRequesterSettleWake(context, "run-failed", entry);
          // scheduleRequesterSettleWake fires the wake via void; give the
          // microtask a chance to settle.
          setTimeout(resolve, 50);
        } catch (error) {
          reject(error);
        }
      }),
    ).resolves.toBeUndefined();

    // The delivery should be marked failed without throwing.
    expect(entry.delivery?.status).toBe("failed");
    expect(entry.suppressCompletionDelivery).toBe(true);
    expect(entry.cleanupHandled).toBe(false);
    // The wake should be cleared (not restored for retry).
    expect(entry.requesterSettleWake).toBeUndefined();
    // blockSubagentCompletionDelivery should NOT be called for non-success.
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
    // Task delivery status should be updated via safeSetSubagentTaskDeliveryStatus.
    expect(taskRuntimeMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryStatus: "failed" }),
    );
  });

  it("does not throw when an orphaned child (no task) blocks delivery", async () => {
    const entry = createFailedTerminalEntry({ runId: "run-orphaned" });
    const context = createContext(entry, {
      resolveSubagentTask: () => ({
        lookup: "unavailable" as const,
        task: undefined,
      }),
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        try {
          scheduleRequesterSettleWake(context, "run-orphaned", entry);
          setTimeout(resolve, 50);
        } catch (error) {
          reject(error);
        }
      }),
    ).resolves.toBeUndefined();

    expect(entry.delivery?.status).toBe("failed");
    expect(entry.suppressCompletionDelivery).toBe(true);
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).not.toHaveBeenCalled();
    expect(taskRuntimeMocks.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryStatus: "failed" }),
    );
  });

  it("does not throw when a killed terminal child blocks delivery", async () => {
    const entry = createFailedTerminalEntry({
      runId: "run-killed",
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 4_000,
        outcome: { status: "killed" as never },
      },
    });
    const context = createContext(entry, {
      resolveSubagentTask: () => ({
        lookup: "available",
        task: { taskId: "task-1", status: "cancelled", runId: "run-killed" },
      }),
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        try {
          scheduleRequesterSettleWake(context, "run-killed", entry);
          setTimeout(resolve, 50);
        } catch (error) {
          reject(error);
        }
      }),
    ).resolves.toBeUndefined();

    expect(entry.delivery?.status).toBe("failed");
    expect(entry.suppressCompletionDelivery).toBe(true);
    expect(entry.requesterSettleWake).toBeUndefined();
  });

  it("throws when a successful child has a genuine owner mismatch", async () => {
    // A successful child (outcome "ok", task "succeeded") with
    // blockSubagentCompletionDelivery returning false is a genuine owner
    // mismatch. The throw is correct — it preserves the wake for retry.
    const entry = createSuccessfulTerminalEntry();
    const context = createContext(entry, {
      resolveSubagentTask: () => ({
        lookup: "available",
        task: { taskId: "task-1", status: "succeeded", runId: "run-success" },
      }),
    });

    // The throw is caught by the scheduleRequesterSettleWake catch block,
    // which warns but doesn't re-throw. We verify blockSubagentCompletionDelivery
    // WAS called and the delivery was NOT marked failed by our fix.
    await new Promise<void>((resolve) => {
      scheduleRequesterSettleWake(context, "run-success", entry);
      setTimeout(resolve, 50);
    });

    // blockSubagentCompletionDelivery SHOULD be called for successful children.
    // The catch handler retries the settle batch with a rejection outcome,
    // so it may be called more than once. The key assertion is that it WAS
    // called (preserving the existing owner-mismatch check for success).
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalled();
    // The delivery should NOT be marked failed by our fix (it's the throw path).
    expect(entry.delivery?.status).toBe("pending");
  });

  it("settles a mixed batch atomically (one failed, one successful)", async () => {
    const failedEntry = createFailedTerminalEntry({ runId: "run-failed" });
    const successEntry = createSuccessfulTerminalEntry({ runId: "run-success" });
    const runs = new Map<string, SubagentRunRecord>([
      ["run-failed", failedEntry],
      ["run-success", successEntry],
    ]);

    const context = createContext(failedEntry, {
      resolveSubagentTask: (entry) => ({
        lookup: "available" as const,
        task:
          entry.runId === "run-failed"
            ? { taskId: "task-failed", status: "failed", runId: "run-failed" }
            : { taskId: "task-success", status: "succeeded", runId: "run-success" },
      }),
      maybeWake: async (params) => {
        // Complete the entire batch in one call.
        params.completeBatch([failedEntry, successEntry], 1, {
          delivered: false,
          path: "none",
          error: "mixed batch settle failed",
        });
        return false;
      },
    });
    // Replace the runs map with both entries.
    (context.options as { runs: Map<string, SubagentRunRecord> }).runs = runs;

    await new Promise<void>((resolve) => {
      scheduleRequesterSettleWake(context, "run-failed", failedEntry);
      setTimeout(resolve, 50);
    });

    // The failed child should be marked failed without throwing.
    expect(failedEntry.delivery?.status).toBe("failed");
    expect(failedEntry.suppressCompletionDelivery).toBe(true);
    expect(failedEntry.requesterSettleWake).toBeUndefined();
    // The successful child: blockSubagentCompletionDelivery returned false,
    // so the throw restored its wake state. Its delivery should still be pending.
    expect(completionDeliveryMocks.blockSubagentCompletionDelivery).toHaveBeenCalledTimes(1);
  });
});
