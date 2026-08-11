import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import type {
  SubagentRegistryLifecycleParams,
  SubagentRegistryLifecycleState,
} from "./subagent-registry-lifecycle-contracts.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

type RequesterSettleWakeBatchState =
  import("../announce/subagent-announce.requester-settle-wake.js").RequesterSettleWakeBatchState;

export function createSubagentRegistryLifecycleRequesterWake(
  params: SubagentRegistryLifecycleParams,
  lifecycleState: SubagentRegistryLifecycleState,
  common: ReturnType<typeof createSubagentRegistryLifecycleCommon>,
) {
  const {
    pendingRequesterSettleWakeRearms,
    scheduledRequesterSettleWakeRuns,
    scheduledRequesterSettleWakeTimers,
  } = lifecycleState;
  const { buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey } = common;

  const transitionRequesterSettleWakeBatch = (
    runIds: readonly string[],
    state: RequesterSettleWakeBatchState,
  ) => {
    const entries = runIds
      .map((runId) => params.runs.get(runId))
      .filter(
        (entry): entry is SubagentRunRecord =>
          Boolean(entry?.requesterSettleWake) &&
          entry?.requesterSettleWake?.rearmGeneration === state.rearmGeneration,
      );
    if (entries.length === 0) {
      return;
    }
    const previousStates = entries.map((entry) => structuredClone(entry.requesterSettleWake));
    for (const entry of entries) {
      entry.requesterSettleWake = {
        ...state,
        ...(entry.requesterSettleWake?.retireAfterSettle === true
          ? { retireAfterSettle: true }
          : {}),
      };
    }
    try {
      params.persistOrThrow(...entries.map((entry) => entry.runId));
    } catch (error) {
      entries.forEach((entry, index) => {
        entry.requesterSettleWake = previousStates[index];
      });
      throw error;
    }
  };

  const completeRequesterSettleWakeBatch = (
    runIds: readonly string[],
    rearmGeneration?: number,
  ) => {
    const entries = runIds
      .map((runId) => [runId, params.runs.get(runId)] as const)
      .filter(
        (pair): pair is readonly [string, SubagentRunRecord] =>
          Boolean(pair[1]?.requesterSettleWake) &&
          pair[1]?.requesterSettleWake?.rearmGeneration === rearmGeneration,
      );
    if (entries.length === 0) {
      return;
    }
    const requesterSessionKeys = new Set(entries.map(([, entry]) => entry.requesterSessionKey));
    const previousStates = entries.map(([, entry]) => ({
      requesterSettleWake: structuredClone(entry.requesterSettleWake),
      retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
    }));
    for (const [runId, entry] of entries) {
      if (entry.requesterTurnRunId) {
        entry.retireAfterRequesterTurn =
          entry.retireAfterRequesterTurn === true ||
          entry.requesterSettleWake?.retireAfterSettle === true
            ? true
            : undefined;
        entry.requesterSettleWake = undefined;
      } else if (entry.requesterSettleWake?.retireAfterSettle === true) {
        params.runs.delete(runId);
      } else {
        entry.requesterSettleWake = undefined;
      }
    }
    try {
      params.persistOrThrow(...entries.map(([runId]) => runId));
    } catch (error) {
      entries.forEach(([runId, entry], index) => {
        const previous = previousStates[index];
        params.runs.set(runId, entry);
        entry.requesterSettleWake = previous?.requesterSettleWake;
        entry.retireAfterRequesterTurn = previous?.retireAfterRequesterTurn;
      });
      throw error;
    }
    for (const [runId, entry] of entries) {
      const retryTimer = scheduledRequesterSettleWakeTimers.get(runId);
      if (retryTimer) {
        clearTimeout(retryTimer.timer);
        scheduledRequesterSettleWakeTimers.delete(runId);
      }
      if (entry.requesterSettleWake === undefined || !params.runs.has(runId)) {
        params.resumedRuns.delete(runId);
        params.clearPendingLifecycleError(runId);
      }
    }
    for (const [runId, entry] of params.runs) {
      if (entry.requesterSettleWake && requesterSessionKeys.has(entry.requesterSessionKey)) {
        scheduleRequesterSettleWake(runId, entry);
      }
    }
  };

  const markRequesterSettleWakePending = (
    entry: SubagentRunRecord,
    options?: { retireAfterSettle?: boolean },
  ) => {
    const existing = entry.requesterSettleWake;
    entry.requesterSettleWake = {
      status: existing?.status ?? "pending",
      attemptCount: existing?.attemptCount ?? 0,
      ...(existing?.replayCount !== undefined ? { replayCount: existing.replayCount } : {}),
      ...(existing?.nextAttemptAt !== undefined ? { nextAttemptAt: existing.nextAttemptAt } : {}),
      ...(existing?.batchRunIds ? { batchRunIds: [...existing.batchRunIds] } : {}),
      ...(existing?.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
      ...(existing?.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
      ...(existing?.rearmGeneration !== undefined
        ? { rearmGeneration: existing.rearmGeneration }
        : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
      ...(existing?.retireAfterSettle === true || options?.retireAfterSettle === true
        ? { retireAfterSettle: true }
        : {}),
    } satisfies RequesterSettleWakeState;
  };

  const persistRequesterSettleWakePending = (
    entry: SubagentRunRecord,
    options?: {
      cleanupCompletedAt?: number;
      retireAfterSettle?: boolean;
      retireInterruptedRecovery?: boolean;
    },
  ) => {
    const previousCleanupCompletedAt = entry.cleanupCompletedAt;
    const previousExecution = entry.execution;
    const previousTerminalOwner = entry.terminalOwner;
    const previousWake = structuredClone(entry.requesterSettleWake);
    if (options?.cleanupCompletedAt !== undefined) {
      entry.cleanupCompletedAt = options.cleanupCompletedAt;
    }
    if (options?.retireInterruptedRecovery) {
      entry.execution = {
        ...entry.execution,
        restartRecovery: undefined,
        suppressSessionEffects: true,
      };
      entry.terminalOwner = undefined;
    }
    markRequesterSettleWakePending(entry, options);
    try {
      params.persistOrThrow(entry.runId);
    } catch (error) {
      entry.cleanupCompletedAt = previousCleanupCompletedAt;
      entry.execution = previousExecution;
      entry.terminalOwner = previousTerminalOwner;
      entry.requesterSettleWake = previousWake;
      throw error;
    }
  };

  // Once a child reaches a terminal settle, let the announce layer decide
  // whether its requester's batch has fully drained and, if so, wake the
  // registry-less top-level requester to synthesize. Settle bookkeeping never
  // blocks on the wake, but the wake must run as tracked root work: a live
  // cleanup parent reserves the root synchronously, so restart or suspend
  // cannot reach quiescence between scheduling and the wake's gateway turn.
  // Failures are logged only.
  function retainScheduledRequesterSettleWakeTimer(
    runId: string,
    deadline: number,
    rearmGeneration?: number,
  ): boolean {
    const scheduled = scheduledRequesterSettleWakeTimers.get(runId);
    if (!scheduled) {
      return false;
    }
    const hasNewerGeneration =
      rearmGeneration !== undefined &&
      (scheduled.rearmGeneration === undefined || rearmGeneration > scheduled.rearmGeneration);
    if (!hasNewerGeneration && deadline >= scheduled.deadline) {
      return true;
    }
    clearTimeout(scheduled.timer);
    scheduledRequesterSettleWakeTimers.delete(runId);
    return false;
  }

  function scheduleRequesterSettleWakeRetry(runId: string, entry: SubagentRunRecord): void {
    const nextAttemptAt = entry.requesterSettleWake?.nextAttemptAt;
    if (nextAttemptAt === undefined || nextAttemptAt <= Date.now()) {
      return;
    }
    const rearmGeneration = entry.requesterSettleWake?.rearmGeneration;
    if (retainScheduledRequesterSettleWakeTimer(runId, nextAttemptAt, rearmGeneration)) {
      return;
    }
    const timer = setTimeout(
      () => {
        if (scheduledRequesterSettleWakeTimers.get(runId)?.timer !== timer) {
          return;
        }
        scheduledRequesterSettleWakeTimers.delete(runId);
        const current = params.runs.get(runId);
        if (current === entry && current.requesterSettleWake) {
          scheduleRequesterSettleWake(runId, current);
        }
      },
      Math.max(0, nextAttemptAt - Date.now()),
    );
    timer.unref?.();
    scheduledRequesterSettleWakeTimers.set(runId, {
      timer,
      deadline: nextAttemptAt,
      rearmGeneration,
    });
  }

  function scheduleRequesterSettleWake(runId: string, entry: SubagentRunRecord): void {
    const requesterSessionKey = entry.requesterSessionKey?.trim();
    // A replayed lifecycle start can retain an older endedAt; require both
    // terminal status and end evidence so a live child never wakes its requester.
    if (
      entry.collect ||
      entry.execution.status === "running" ||
      !hasSubagentRunEnded(entry) ||
      !requesterSessionKey ||
      (entry.requesterTurnRunId && entry.requesterTurnYielded === true) ||
      scheduledRequesterSettleWakeRuns.has(runId)
    ) {
      return;
    }
    const now = Date.now();
    const nextAttemptAt = entry.requesterSettleWake?.nextAttemptAt;
    const deadline = nextAttemptAt !== undefined && nextAttemptAt > now ? nextAttemptAt : now;
    if (
      retainScheduledRequesterSettleWakeTimer(
        runId,
        deadline,
        entry.requesterSettleWake?.rearmGeneration,
      )
    ) {
      return;
    }
    if (nextAttemptAt !== undefined && nextAttemptAt > now) {
      scheduleRequesterSettleWakeRetry(runId, entry);
      return;
    }
    scheduledRequesterSettleWakeRuns.add(runId);
    // Wake turns outlive their spawning attempt; clear its owner before both
    // dispatch and chained re-arms so transcript writes acquire a fresh lock.
    runWithoutOwnedSessionTranscriptWrites(() => {
      void runWithGatewayIndependentRootWorkContinuation(() =>
        params.maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey,
          requesterOrigin: entry.requesterOrigin,
          settledEntry: entry,
          transitionBatch: transitionRequesterSettleWakeBatch,
          completeBatch: completeRequesterSettleWakeBatch,
        }),
      )
        .catch((error: unknown) => {
          params.warn("requester settle wake failed", {
            error: buildSafeLifecycleErrorMeta(error),
            runId: maskRunId(runId),
            requesterSessionKey: maskSessionKey(requesterSessionKey),
          });
        })
        .finally(() => {
          scheduledRequesterSettleWakeRuns.delete(runId);
          const wasRearmedWhileRunning = pendingRequesterSettleWakeRearms.delete(runId);
          const current = params.runs.get(runId);
          if (current === entry && current.requesterSettleWake) {
            if (wasRearmedWhileRunning) {
              // A requester yield can freeze a delivered batch while this run is
              // resolving its earlier no-wake decision. Admit that durable update now.
              scheduleRequesterSettleWake(runId, current);
            } else {
              scheduleRequesterSettleWakeRetry(runId, current);
            }
          }
        });
    });
  }

  return {
    markRequesterSettleWakePending,
    persistRequesterSettleWakePending,
    scheduleRequesterSettleWake,
  };
}
