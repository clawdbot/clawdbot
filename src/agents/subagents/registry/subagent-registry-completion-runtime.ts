import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const GATEWAY_ADMISSION_RETRY_DELAY_MS = 1_000;

export function createSubagentRegistryCompletionRuntime(config: {
  runs: Map<string, SubagentRunRecord>;
  resumed: Set<string>;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
  completeSubagentRun: (params: SubagentCompletionRequest) => Promise<void>;
  scheduleSweep: (params?: { delayMs?: number }) => void;
  resumeRun: (runId: string) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs, resumed, retryTimers, completeSubagentRun, scheduleSweep, resumeRun, warn } =
    config;

  async function completeSubagentRunWithRecoveryAttempt(
    params: SubagentCompletionRequest,
    source: string,
  ) {
    try {
      await completeSubagentRun(params);
      return;
    } catch (error) {
      const current = runs.get(params.runId);
      warn("failed to complete subagent run; retrying completion", {
        source,
        runId: params.runId,
        childSessionKey: current?.childSessionKey,
        error,
      });
    }

    const current = runs.get(params.runId);
    if (!current) {
      return;
    }

    try {
      await completeSubagentRun(params);
      return;
    } catch (retryError) {
      warn("failed to complete subagent run after retry; retrying ended cleanup", {
        source,
        runId: params.runId,
        childSessionKey: current.childSessionKey,
        error: retryError,
      });
    }

    const latest = runs.get(params.runId);
    if (latest && typeof latest.execution.endedAt !== "number") {
      // The durable write rolled the in-memory entry back. Preserve the original
      // completion through the normal persisted-session recovery path.
      scheduleSweep({ delayMs: 1_000 });
      return;
    }
    if (
      !latest ||
      typeof latest.execution.endedAt !== "number" ||
      typeof latest.cleanupCompletedAt === "number" ||
      latest.pauseReason === "sessions_yield"
    ) {
      return;
    }
    latest.cleanupHandled = false;
    resumed.delete(params.runId);
    resumeRun(params.runId);
  }

  function scheduleSubagentCompletionRetryAfterRestart(
    params: SubagentCompletionRequest,
    source: string,
    expectedEntry: SubagentRunRecord,
  ) {
    const expectedGeneration = expectedEntry.generation;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      const current = runs.get(params.runId);
      if (current !== expectedEntry || current.generation !== expectedGeneration) {
        return;
      }
      completeSubagentRunInBackground(params, source, "restart-retry");
    }, GATEWAY_ADMISSION_RETRY_DELAY_MS);
    timer.unref?.();
    retryTimers.add(timer);
  }

  async function completeSubagentRunWithRecovery(
    params: SubagentCompletionRequest,
    source: string,
  ) {
    // Each controller attempt owns its terminal transition, while this outer
    // lease closes the gap between failed attempts and fallback cleanup.
    try {
      await runWithGatewayIndependentRootWorkContinuation(async () => {
        await completeSubagentRunWithRecoveryAttempt(params, source);
      });
    } catch (error) {
      if (!isGatewayRestartDraining()) {
        throw error;
      }
      warn("subagent completion deferred during gateway restart", {
        source,
        runId: params.runId,
      });
      const current = runs.get(params.runId);
      if (current) {
        scheduleSubagentCompletionRetryAfterRestart(params, source, current);
      }
    }
  }

  // The recovery wrapper rethrows non-draining errors by design, so this detached
  // boundary must land them in the log; an uncaught rejection here hits the
  // process-level unhandled-rejection fatal path and exits the gateway.
  function completeSubagentRunInBackground(
    params: SubagentCompletionRequest,
    source: string,
    origin: "background" | "restart-retry" = "background",
  ) {
    void completeSubagentRunWithRecovery(params, source).catch((error: unknown) => {
      // A delayed post-restart retry that still fails is a distinct recovery
      // failure: operators must be able to tell it apart from an initial
      // background completion loss in the shared detached boundary.
      warn(
        origin === "restart-retry"
          ? "failed to retry subagent completion after gateway restart"
          : "failed to complete subagent run in background",
        {
          source,
          runId: params.runId,
          error,
        },
      );
    });
  }

  const pendingLifecycle = createPendingLifecycleScheduler({
    runs,
    completeInBackground: completeSubagentRunInBackground,
  });

  function hasCompleteSubagentTerminalState(entry: SubagentRunRecord | undefined): boolean {
    return (
      entry !== undefined &&
      typeof entry.execution.endedAt === "number" &&
      Number.isFinite(entry.execution.endedAt) &&
      entry.execution.outcome !== undefined &&
      entry.endedReason !== undefined &&
      entry.execution.status === "terminal"
    );
  }

  async function finalizeInterruptedSubagentRun(params: {
    runId: string;
    expectedEntry?: SubagentRunRecord;
    error: string;
    endedAt?: number;
    suppressSessionEffects?: boolean;
  }): Promise<number> {
    const runId = params.runId.trim();
    if (!runId) {
      return 0;
    }

    const endedAt =
      typeof params.endedAt === "number" && Number.isFinite(params.endedAt)
        ? params.endedAt
        : Date.now();
    const entry = runs.get(runId);
    if (!entry || (params.expectedEntry && entry !== params.expectedEntry)) {
      return 0;
    }
    pendingLifecycle.clear(runId);
    if (
      typeof entry.cleanupCompletedAt === "number" &&
      entry.terminalOwner !== "interrupted-recovery"
    ) {
      return hasCompleteSubagentTerminalState(entry) ? 1 : 0;
    }
    const completionParams: SubagentCompletionRequest = {
      runId,
      expectedEntry: entry,
      endedAt,
      outcome: {
        status: "error",
        error: params.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      recoverInterrupted: true,
      suppressSessionEffects: params.suppressSessionEffects,
    };
    try {
      await completeSubagentRun(completionParams);
      // A successfully finalized stale generation can be retired once a newer
      // generation owns the session; the captured exact row still has its result.
      const finalized = runs.get(runId) ?? entry;
      // Recovery preserves partial terminal evidence instead of overwriting it.
      // Keep scheduler retries alive until the exact row is fully terminal.
      return hasCompleteSubagentTerminalState(finalized) ? 1 : 0;
    } catch (error) {
      if (isGatewayRestartDraining() && runs.get(runId) === entry) {
        warn("subagent completion deferred during gateway restart", {
          source: "explicit-failed-mark",
          runId,
        });
        scheduleSubagentCompletionRetryAfterRestart(
          completionParams,
          "explicit-failed-mark",
          entry,
        );
        return 1;
      }
      warn("failed to durably finalize interrupted subagent run", {
        runId,
        childSessionKey: entry.childSessionKey,
        error,
      });
      return 0;
    }
  }

  return {
    pendingLifecycle,
    completeSubagentRunWithRecovery,
    finalizeInterruptedSubagentRun,
    scheduleSubagentCompletionRetryAfterRestart,
  };
}
