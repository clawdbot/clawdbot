import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import {
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
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

const isCurrentRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  batch: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  visibleFinalDelivered = false,
): boolean => {
  // Closure can precede replacement activation. Only a recorded visible final
  // may settle then; cancellation or an in-flight handoff must retain the wake.
  try {
    return (
      batch.length > 0 &&
      (visibleFinalDelivered ||
        batch.every((entry) => {
          const resolve = getGatewayContextResolver(entry);
          return !resolve || Boolean(resolve());
        })) &&
      // Validate every row and generation after calling the captured owner fences.
      batch.every(
        (entry) =>
          context.options.runs.get(entry.runId) === entry &&
          entry.requesterSettleWake &&
          entry.requesterSettleWake.rearmGeneration === rearmGeneration,
      )
    );
  } catch {
    return false;
  }
};

const transitionRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  state: RequesterSettleWakeBatchState,
) => {
  const params = context.options;
  if (!isCurrentRequesterSettleWakeBatch(context, entries, state.rearmGeneration)) {
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
  entries: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  outcome?: SubagentAnnounceDeliveryResult,
) => {
  const params = context.options;
  if (
    !isCurrentRequesterSettleWakeBatch(
      context,
      entries,
      rearmGeneration,
      outcome?.delivered === true && outcome.requesterVisibleFinalDelivered === true,
    )
  ) {
    return;
  }
  const requesterSessionKeys = new Set(entries.map((entry) => entry.requesterSessionKey));
  const previousStates = entries.map((entry) => ({
    delivery: structuredClone(entry.delivery),
    requesterSettleWake: structuredClone(entry.requesterSettleWake),
    retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
    suppressCompletionDelivery: entry.suppressCompletionDelivery,
  }));
  const settledDeliveries: SubagentRunRecord[] = [];
  for (const entry of entries) {
    const { runId } = entry;
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
    params.persistOrThrow(...entries.map((entry) => entry.runId));
  } catch (error) {
    entries.forEach((entry, index) => {
      const { runId } = entry;
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
  for (const entry of entries) {
    const { runId } = entry;
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
  for (const entry of entries) {
    const { runId } = entry;
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
// Terminal failures settle only the exact wake so a newer requester-yield rearm survives.
function retainScheduledRequesterSettleWakeTimer(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  deadline: number,
): boolean {
  const scheduled = context.getRequesterSettleWakeTimer(entry.runId);
  if (!scheduled) {
    return false;
  }
  const rearmGeneration = entry.requesterSettleWake?.rearmGeneration;
  const hasNewerGeneration =
    rearmGeneration !== undefined &&
    (scheduled.rearmGeneration === undefined || rearmGeneration > scheduled.rearmGeneration);
  // A restored owner must not inherit a timer whose callback still captures the old row.
  if (scheduled.entry === entry && !hasNewerGeneration && deadline >= scheduled.deadline) {
    return true;
  }
  clearTimeout(scheduled.timer);
  context.deleteRequesterSettleWakeTimer(entry.runId);
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
  if (retainScheduledRequesterSettleWakeTimer(context, entry, nextAttemptAt)) {
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
    entry,
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
    context.hasScheduledRequesterSettleWakeRun(entry)
  ) {
    return;
  }
  const now = Date.now();
  const nextAttemptAt = entry.requesterSettleWake?.nextAttemptAt;
  const deadline = nextAttemptAt !== undefined && nextAttemptAt > now ? nextAttemptAt : now;
  if (retainScheduledRequesterSettleWakeTimer(context, entry, deadline)) {
    return;
  }
  if (nextAttemptAt !== undefined && nextAttemptAt > now) {
    scheduleRequesterSettleWakeRetry(context, runId, entry);
    return;
  }
  const admittedBatch = (admittedWake?.batchRunIds ?? [runId]).flatMap((id) => {
    const member = params.runs.get(id);
    return member ? [member] : [];
  });
  context.markRequesterSettleWakeRunScheduled(entry);
  // Wake turns outlive their spawning attempt; clear its owner before both
  // dispatch and chained re-arms so transcript writes acquire a fresh lock.
  runWithoutOwnedSessionTranscriptWrites(() => {
    void context
      .runRequesterSettleWake(entry, () =>
        params.maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey,
          requesterOrigin: entry.requesterOrigin,
          settledEntry: entry,
          transitionBatch: (batch, state) =>
            transitionRequesterSettleWakeBatch(context, batch, state),
          completeBatch: (batch, rearmGeneration, outcome) =>
            completeRequesterSettleWakeBatch(context, batch, rearmGeneration, outcome),
        }),
      )
      .catch((error: unknown) => {
        // Restart admission defers the durable wake to startup; it is not a delivery failure.
        if (isGatewayRestartDrainError(error)) {
          return;
        }
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
          completeRequesterSettleWakeBatch(context, admittedBatch, admittedWake.rearmGeneration, {
            delivered: false,
            path: "none",
            error: safeError.message,
          });
        } catch (settleError) {
          params.warn("failed to persist requester settle wake rejection", {
            error: buildSafeLifecycleErrorMeta(settleError),
            runId: maskLifecycleIdentifier(runId, "run"),
            requesterSessionKey: maskLifecycleIdentifier(requesterSessionKey, "session"),
          });
        }
      })
      .finally(() => {
        context.unmarkRequesterSettleWakeRunScheduled(entry);
        const wasRearmedWhileRunning = context.takeRequesterSettleWakeRearm(entry);
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
