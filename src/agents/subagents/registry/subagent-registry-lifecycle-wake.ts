import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { clearGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { blockSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import { ensureDeliveryState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type {
  CleanupBookkeepingParams,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  markRequesterSettleWakePending,
  maskLifecycleIdentifier,
  safeSetSubagentTaskDeliveryStatus,
} from "./subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

type RequesterSettleWakeBatchState =
  import("../announce/subagent-announce.requester-settle-wake.js").RequesterSettleWakeBatchState;

const transitionRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  runIds: readonly string[],
  state: RequesterSettleWakeBatchState,
) => {
  const params = context.options;
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
      ...(entry.requesterSettleWake?.retireAfterSettle === true ? { retireAfterSettle: true } : {}),
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
  context: SubagentLifecycleWakeContext,
  runIds: readonly string[],
  rearmGeneration?: number,
  outcome?: SubagentAnnounceDeliveryResult,
) => {
  const params = context.options;
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
    delivery: structuredClone(entry.delivery),
    requesterSettleWake: structuredClone(entry.requesterSettleWake),
    retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
    suppressCompletionDelivery: entry.suppressCompletionDelivery,
  }));
  const settledDeliveries: SubagentRunRecord[] = [];
  for (const [runId, entry] of entries) {
    if (
      outcome &&
      entry.expectsCompletionMessage === true &&
      ["pending", "in_progress"].includes(entry.delivery?.status ?? "pending")
    ) {
      if (outcome.delivered) {
        const delivery = ensureDeliveryState(entry);
        const deliveredAt = outcome.deliveredAt ?? Date.now();
        delivery.status = "delivered";
        delivery.disposition = "delivered";
        delivery.deliveredAt = deliveredAt;
        delivery.announcedAt = deliveredAt;
        delivery.lastError = undefined;
        delivery.lastDropReason = undefined;
      } else {
        const error = outcome.error ?? outcome.reason ?? "requester settle wake failed";
        if (
          !blockSubagentCompletionDelivery({
            subagent: entry,
            taskId: params.resolveSubagentTask(entry).task?.taskId ?? "",
            reason: error,
            disposition: outcome.disposition,
          })
        ) {
          throw new Error(`subagent completion owner changed before settlement: ${runId}`);
        }
      }
      settledDeliveries.push(entry);
    }
    if (entry.requesterTurnRunId && entry.expectsCompletionMessage === true) {
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
      if (outcome?.delivered !== false || !settledDeliveries.includes(entry)) {
        entry.delivery = previous?.delivery;
        entry.suppressCompletionDelivery = previous?.suppressCompletionDelivery;
      }
      entry.requesterSettleWake = previous?.requesterSettleWake;
      entry.retireAfterRequesterTurn = previous?.retireAfterRequesterTurn;
    });
    throw error;
  }
  for (const [runId, entry] of entries) {
    if (!params.runs.has(runId)) {
      subagentRuns.confirmRetirement(entry);
    }
  }
  for (const entry of settledDeliveries) {
    if (outcome?.delivered) {
      safeSetSubagentTaskDeliveryStatus(params, {
        entry,
        deliveryStatus: "delivered",
      });
    }
  }
  for (const [runId, entry] of entries) {
    const retryTimer = context.getRequesterSettleWakeTimer(runId);
    if (retryTimer) {
      clearTimeout(retryTimer.timer);
      context.deleteRequesterSettleWakeTimer(runId);
    }
    if (entry.requesterSettleWake === undefined || !params.runs.has(runId)) {
      clearGatewayContextResolver(entry);
      params.resumedRuns.delete(runId);
      params.clearPendingLifecycleError(runId);
    }
  }
  for (const [runId, entry] of params.runs) {
    if (entry.requesterSettleWake && requesterSessionKeys.has(entry.requesterSessionKey)) {
      scheduleRequesterSettleWake(context, runId, entry);
    }
  }
};

const persistRequesterSettleWakePending = (
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  options?: {
    cleanupCompletedAt?: number;
    retireAfterSettle?: boolean;
    retireInterruptedRecovery?: boolean;
  },
) => {
  const params = context.options;
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
// Failures settle only the exact admitted wake so a newer requester-yield rearm survives.
function retainScheduledRequesterSettleWakeTimer(
  context: SubagentLifecycleWakeContext,
  runId: string,
  deadline: number,
  rearmGeneration?: number,
): boolean {
  const scheduled = context.getRequesterSettleWakeTimer(runId);
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
  context.deleteRequesterSettleWakeTimer(runId);
  return false;
}

function scheduleRequesterSettleWakeRetry(
  context: SubagentLifecycleWakeContext,
  runId: string,
  entry: SubagentRunRecord,
): void {
  const params = context.options;
  const nextAttemptAt = entry.requesterSettleWake?.nextAttemptAt;
  if (nextAttemptAt === undefined || nextAttemptAt <= Date.now()) {
    return;
  }
  const rearmGeneration = entry.requesterSettleWake?.rearmGeneration;
  if (retainScheduledRequesterSettleWakeTimer(context, runId, nextAttemptAt, rearmGeneration)) {
    return;
  }
  const timer = setTimeout(
    () => {
      if (context.getRequesterSettleWakeTimer(runId)?.timer !== timer) {
        return;
      }
      context.deleteRequesterSettleWakeTimer(runId);
      const current = params.runs.get(runId);
      if (current === entry && current.requesterSettleWake) {
        scheduleRequesterSettleWake(context, runId, current);
      }
    },
    Math.max(0, nextAttemptAt - Date.now()),
  );
  timer.unref?.();
  context.setRequesterSettleWakeTimer(runId, {
    timer,
    deadline: nextAttemptAt,
    rearmGeneration,
  });
}

export function scheduleRequesterSettleWake(
  context: SubagentLifecycleWakeContext,
  runId: string,
  entry: SubagentRunRecord,
): void {
  const params = context.options;
  const admittedWake = entry.requesterSettleWake;
  const requesterSessionKey = entry.requesterSessionKey?.trim();
  // A replayed lifecycle start can retain an older endedAt; require both
  // terminal status and end evidence so a live child never wakes its requester.
  if (
    entry.collect ||
    entry.execution.status === "running" ||
    !hasSubagentRunEnded(entry) ||
    !requesterSessionKey ||
    (entry.requesterTurnRunId && entry.expectsCompletionMessage === true) ||
    context.hasScheduledRequesterSettleWakeRun(runId)
  ) {
    return;
  }
  const now = Date.now();
  const nextAttemptAt = entry.requesterSettleWake?.nextAttemptAt;
  const deadline = nextAttemptAt !== undefined && nextAttemptAt > now ? nextAttemptAt : now;
  if (
    retainScheduledRequesterSettleWakeTimer(
      context,
      runId,
      deadline,
      entry.requesterSettleWake?.rearmGeneration,
    )
  ) {
    return;
  }
  if (nextAttemptAt !== undefined && nextAttemptAt > now) {
    scheduleRequesterSettleWakeRetry(context, runId, entry);
    return;
  }
  context.markRequesterSettleWakeRunScheduled(runId);
  // Wake turns outlive their spawning attempt; clear its owner before both
  // dispatch and chained re-arms so transcript writes acquire a fresh lock.
  runWithoutOwnedSessionTranscriptWrites(() => {
    void context
      .runRequesterSettleWake(runId, () =>
        params.maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey,
          requesterOrigin: entry.requesterOrigin,
          settledEntry: entry,
          transitionBatch: (runIds, state) =>
            transitionRequesterSettleWakeBatch(context, runIds, state),
          completeBatch: (runIds, rearmGeneration, outcome) =>
            completeRequesterSettleWakeBatch(context, runIds, rearmGeneration, outcome),
        }),
      )
      .catch((error: unknown) => {
        const safeError = buildSafeLifecycleErrorMeta(error);
        params.warn("requester settle wake failed", {
          error: safeError,
          runId: maskLifecycleIdentifier(runId, "run"),
          requesterSessionKey: maskLifecycleIdentifier(requesterSessionKey, "session"),
        });
        const current = params.runs.get(runId);
        if (!admittedWake || current !== entry || current.requesterSettleWake !== admittedWake) {
          return;
        }
        try {
          completeRequesterSettleWakeBatch(
            context,
            admittedWake.batchRunIds ?? [runId],
            admittedWake.rearmGeneration,
            { delivered: false, path: "none", error: safeError.message },
          );
        } catch (settleError) {
          params.warn("failed to persist requester settle wake rejection", {
            error: buildSafeLifecycleErrorMeta(settleError),
            runId: maskLifecycleIdentifier(runId, "run"),
            requesterSessionKey: maskLifecycleIdentifier(requesterSessionKey, "session"),
          });
        }
      })
      .finally(() => {
        context.unmarkRequesterSettleWakeRunScheduled(runId);
        const wasRearmedWhileRunning = context.takeRequesterSettleWakeRearm(runId);
        const current = params.runs.get(runId);
        if (current === entry && current.requesterSettleWake) {
          if (wasRearmedWhileRunning) {
            // A requester yield can freeze a delivered batch while this run is
            // resolving its earlier no-wake decision. Admit that durable update now.
            scheduleRequesterSettleWake(context, runId, current);
          } else {
            scheduleRequesterSettleWakeRetry(context, runId, current);
          }
        }
      });
  });
}

export function completeCleanupBookkeeping(
  context: SubagentLifecycleWakeContext,
  cleanupParams: CleanupBookkeepingParams,
  retryDeferredCompletedAnnounces: (excludeRunId?: string) => void,
): void {
  const params = context.options;
  const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(cleanupParams.entry);
  const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
    // These best-effort tails can outlive the durable registry transition,
    // but they still mutate session-owned resources and must block snapshots.
    void runWithGatewayIndependentRootWorkAdmission(run, "subagents:lifecycle-cleanup").catch(
      (error: unknown) => {
        defaultRuntime.log(
          `[warn] subagent ${label} failed (${cleanupParams.runId}): ${String(error)}`,
        );
      },
    );
  };
  const scheduleCleanupTails = (options: {
    allowRetiredRow: boolean;
    isDeleteCleanup: boolean;
  }) => {
    // Retained bookkeeping requires the exact row. Immediate retirement
    // removes it first, so absence remains ownership only while no newer
    // child generation exists; any replacement blocks the stale cleanup.
    const postBookkeepingEffectsAllowed = () => {
      const current = params.runs.get(cleanupParams.runId);
      const rowOwnershipMatches =
        current === cleanupParams.entry || (options.allowRetiredRow && current === undefined);
      return (
        rowOwnershipMatches &&
        !context.newerGenerationOwnsSession(cleanupParams.entry) &&
        !shouldSuppressSubagentRecoverySessionEffects(cleanupParams.entry)
      );
    };
    if (postBookkeepingEffectsAllowed() && !cleanupParams.preserveTranscript) {
      runCleanupTail("session cleanup", async () => {
        if (!postBookkeepingEffectsAllowed()) {
          return;
        }
        await removeInternalSessionEffectsSession(cleanupParams.entry.execution.transcriptTarget);
      });
    }
    if (postBookkeepingEffectsAllowed() && cleanupParams.entry.spawnMode !== "session") {
      runCleanupTail("bundle MCP cleanup", async () => {
        if (!postBookkeepingEffectsAllowed()) {
          return;
        }
        await retireSessionMcpRuntimeForSessionKey({
          sessionKey: cleanupParams.entry.childSessionKey,
          reason: "subagent-run-cleanup",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: maskLifecycleIdentifier(cleanupParams.runId, "run"),
              childSessionKey: maskLifecycleIdentifier(
                cleanupParams.entry.childSessionKey,
                "session",
              ),
            });
          },
        });
      });
    }
    if (
      !cleanupParams.provisionalKill &&
      postBookkeepingEffectsAllowed() &&
      (options.isDeleteCleanup || !cleanupParams.entry.collect)
    ) {
      runCleanupTail("context-engine cleanup", async () => {
        if (!postBookkeepingEffectsAllowed()) {
          return;
        }
        await params.notifyContextEngineSubagentEnded(
          {
            childSessionKey: cleanupParams.entry.childSessionKey,
            reason: options.isDeleteCleanup ? "deleted" : "completed",
            agentDir: cleanupParams.entry.agentDir,
            workspaceDir: cleanupParams.entry.workspaceDir,
          },
          { isCurrent: postBookkeepingEffectsAllowed },
        );
      });
    }
  };
  if (cleanupParams.provisionalKill) {
    // The provider result or bounded kill reconciliation owns terminal settle.
    // Its kill marker was committed by the caller before reaching this tail.
    scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup: false });
    return;
  }
  const isDeleteCleanup = cleanupParams.cleanup === "delete";
  if (isDeleteCleanup) {
    params.clearPendingLifecycleError(cleanupParams.runId);
  }
  if (cleanupParams.entry.collect) {
    // Delete-mode session cleanup already ran before this durable bookkeeping.
    // Preserve only the collector result tombstone for waits and group caps.
    const previousCleanupCompletedAt = cleanupParams.entry.cleanupCompletedAt;
    const previousExecution = cleanupParams.entry.execution;
    const previousRequesterSettleWake = cleanupParams.entry.requesterSettleWake;
    const previousTerminalOwner = cleanupParams.entry.terminalOwner;
    cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
    cleanupParams.entry.requesterSettleWake = undefined;
    if (suppressSessionEffects) {
      cleanupParams.entry.execution = {
        ...cleanupParams.entry.execution,
        restartRecovery: undefined,
        suppressSessionEffects: true,
      };
      cleanupParams.entry.terminalOwner = undefined;
    }
    try {
      params.persistOrThrow(cleanupParams.runId);
    } catch (error) {
      cleanupParams.entry.cleanupCompletedAt = previousCleanupCompletedAt;
      cleanupParams.entry.execution = previousExecution;
      cleanupParams.entry.requesterSettleWake = previousRequesterSettleWake;
      cleanupParams.entry.terminalOwner = previousTerminalOwner;
      throw error;
    }
    clearGatewayContextResolver(cleanupParams.entry);
    scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup });
    retryDeferredCompletedAnnounces(cleanupParams.runId);
    return;
  }
  const retireAfterSettle =
    isDeleteCleanup ||
    (cleanupParams.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      cleanupParams.entry.suppressAnnounceReason !== "killed");
  if (retireAfterSettle) {
    // Reconciled keep-mode kills retire the registry row, not the child session.
    if (!isDeleteCleanup) {
      params.clearPendingLifecycleError(cleanupParams.runId);
    }
    if (cleanupParams.skipRequesterSettleWake) {
      params.runs.delete(cleanupParams.runId);
      try {
        params.persistOrThrow(cleanupParams.runId);
      } catch (error) {
        params.runs.set(cleanupParams.runId, cleanupParams.entry);
        throw error;
      }
      subagentRuns.confirmRetirement(cleanupParams.entry);
      clearGatewayContextResolver(cleanupParams.entry);
      scheduleCleanupTails({ allowRetiredRow: true, isDeleteCleanup });
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    persistRequesterSettleWakePending(context, cleanupParams.entry, {
      cleanupCompletedAt: cleanupParams.completedAt,
      retireAfterSettle: true,
      retireInterruptedRecovery: suppressSessionEffects,
    });
    // The settle wake may synchronously retire this durably marked row before
    // the detached tails start. Absence is still stale-safe because any
    // replacement row or newer child generation rejects the cleanup.
    scheduleCleanupTails({ allowRetiredRow: true, isDeleteCleanup });
    retryDeferredCompletedAnnounces(cleanupParams.runId);
    scheduleRequesterSettleWake(context, cleanupParams.runId, cleanupParams.entry);
    return;
  }
  if (!cleanupParams.skipRequesterSettleWake) {
    persistRequesterSettleWakePending(context, cleanupParams.entry, {
      cleanupCompletedAt: cleanupParams.completedAt,
      retireInterruptedRecovery: suppressSessionEffects,
    });
  } else {
    const previousCleanupCompletedAt = cleanupParams.entry.cleanupCompletedAt;
    const previousExecution = cleanupParams.entry.execution;
    const previousTerminalOwner = cleanupParams.entry.terminalOwner;
    cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
    if (suppressSessionEffects) {
      cleanupParams.entry.execution = {
        ...cleanupParams.entry.execution,
        restartRecovery: undefined,
        suppressSessionEffects: true,
      };
      cleanupParams.entry.terminalOwner = undefined;
    }
    try {
      params.persistOrThrow(cleanupParams.runId);
    } catch (error) {
      cleanupParams.entry.cleanupCompletedAt = previousCleanupCompletedAt;
      cleanupParams.entry.execution = previousExecution;
      cleanupParams.entry.terminalOwner = previousTerminalOwner;
      throw error;
    }
    clearGatewayContextResolver(cleanupParams.entry);
  }
  scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup });
  retryDeferredCompletedAnnounces(cleanupParams.runId);
  if (!cleanupParams.skipRequesterSettleWake) {
    scheduleRequesterSettleWake(context, cleanupParams.runId, cleanupParams.entry);
  }
}
