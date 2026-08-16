import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import type { DetachedTaskFindResult } from "../../../tasks/detached-task-runtime-contract.js";
import { isProvisionalSubagentKillTask } from "../../../tasks/task-cancellation-state.js";
import { mergeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { peekSwarmStructuredOutput } from "../../tools/structured-output-tool.js";
import {
  type SubagentRunOutcome,
  withSubagentOutcomeTiming,
} from "../announce/subagent-announce-output.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { clearDeliveryState, ensureCompletionState } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { resolveKilledSubagentTaskEndedAt } from "./subagent-registry-completion.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import { completeTerminalEffects } from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleCompletionContext } from "./subagent-registry-lifecycle-context.js";
import {
  freezeRunResultAtCompletion,
  refreshPendingFinalDeliveryPayload,
  safeFinalizeSubagentTaskRun,
} from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";

type BrowserCleanupModule = typeof import("../../../browser-lifecycle-cleanup.js");
type BrowserCleanup = BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"];

const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../../../browser-lifecycle-cleanup.js"),
);

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<BrowserCleanup> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

function shouldPreservePublishedExplicitRunTimeout(params: { entry: SubagentRunRecord }): boolean {
  if (
    typeof params.entry.runTimeoutSeconds !== "number" ||
    !Number.isFinite(params.entry.runTimeoutSeconds) ||
    params.entry.runTimeoutSeconds <= 0 ||
    params.entry.execution.outcome?.status !== "timeout" ||
    typeof params.entry.execution.endedAt !== "number"
  ) {
    return false;
  }
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry);
  if (deadlineMs === undefined || params.entry.execution.endedAt < deadlineMs) {
    return false;
  }
  return (
    params.entry.cleanupHandled === true ||
    typeof params.entry.cleanupCompletedAt === "number" ||
    typeof params.entry.endedHookEmittedAt === "number" ||
    params.entry.delivery?.status === "delivered" ||
    typeof params.entry.delivery?.announcedAt === "number"
  );
}

function resolveExpiredExplicitRunDeadlineMs(params: {
  entry: SubagentRunRecord;
  nextEndedAt: number;
  observedStartedAt?: number;
}): number | undefined {
  const effectiveEndedAt = resolveSubagentRunEffectiveEndedAt(
    params.entry,
    params.nextEndedAt,
    params.observedStartedAt,
  );
  return effectiveEndedAt < params.nextEndedAt ? effectiveEndedAt : undefined;
}

function isOlderEquivalentTerminalCallback(params: {
  entry: SubagentRunRecord;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
}): boolean {
  const current = params.entry.execution.outcome;
  if (
    typeof params.entry.execution.endedAt !== "number" ||
    params.endedAt >= params.entry.execution.endedAt ||
    params.entry.endedReason !== params.reason ||
    current?.status !== params.outcome.status
  ) {
    return false;
  }
  return (
    current.status !== "error" ||
    params.outcome.status !== "error" ||
    current.error === params.outcome.error
  );
}

export async function completeSubagentRunAttempt(
  context: SubagentLifecycleCompletionContext,
  completeParams: SubagentCompletionRequest,
): Promise<void> {
  const params = context.options;
  const releaseCompletionLock = await context.acquireTerminalCompletionLock(completeParams.runId);
  let entry: SubagentRunRecord | undefined;
  let terminalGeneration = 0;
  let mutated = false;
  let completionReason = completeParams.reason;
  let sessionSuperseded = false;
  let suppressSessionEffects = completeParams.suppressSessionEffects === true;
  let suppressTaskFinalization: boolean;
  let provisionalKillSnapshot: SubagentRunRecord | undefined;
  let postCaptureTaskResolution: DetachedTaskFindResult | undefined;
  let entrySnapshot: SubagentRunRecord | undefined;
  try {
    entry = params.runs.get(completeParams.runId);
    if (!entry) {
      return;
    }
    if (completeParams.expectedEntry && entry !== completeParams.expectedEntry) {
      return;
    }
    suppressSessionEffects ||= shouldSuppressSubagentRecoverySessionEffects(entry);
    params.clearPendingLifecycleError(completeParams.runId);
    const currentEntry = entry;
    entrySnapshot = structuredClone(entry);
    const restoreEntrySnapshot = (snapshot?: SubagentRunRecord) => {
      if (!snapshot) {
        return;
      }
      for (const key of Object.keys(currentEntry)) {
        Reflect.deleteProperty(currentEntry, key);
      }
      Object.assign(currentEntry, snapshot);
    };
    const recoveryRequested = completeParams.recoverInterrupted === true;
    if (
      !recoveryRequested &&
      (entry.terminalOwner === "interrupted-recovery" ||
        entry.execution.suppressSessionEffects === true) &&
      entry.killIntent === undefined
    ) {
      // Restart recovery already persisted the terminal winner for this exact
      // run. Its sticky fence survives cleanup of the transient owner marker.
      return;
    }
    if (recoveryRequested) {
      const ownsInterruptedRecovery = entry.terminalOwner === "interrupted-recovery";
      // Mismatched partial terminal evidence is an existing winner and must
      // not be overwritten. Exact normalized evidence may be the same recovery
      // request deferred by restart admission, so drain it.
      const hasTerminalEvidence =
        entry.execution.status === "terminal" ||
        entry.endedReason !== undefined ||
        typeof entry.cleanupCompletedAt === "number";
      const expectedElapsedMs =
        typeof currentEntry.execution.startedAt === "number" &&
        typeof completeParams.endedAt === "number"
          ? Math.max(0, completeParams.endedAt - currentEntry.execution.startedAt)
          : undefined;
      const outcomeMatchesInterruptedRecovery = (outcome: SubagentRunOutcome | undefined) =>
        completeParams.outcome.status === "error" &&
        outcome?.status === "error" &&
        outcome.error === completeParams.outcome.error &&
        (outcome.startedAt === undefined ||
          outcome.startedAt === currentEntry.execution.startedAt) &&
        (outcome.endedAt === undefined || outcome.endedAt === completeParams.endedAt) &&
        (outcome.elapsedMs === undefined || outcome.elapsedMs === expectedElapsedMs);
      const matchesRequestedInterruptedTerminal =
        typeof completeParams.endedAt === "number" &&
        entry.execution.endedAt === completeParams.endedAt &&
        outcomeMatchesInterruptedRecovery(entry.execution.outcome) &&
        entry.endedReason === SUBAGENT_ENDED_REASON_ERROR;
      if (
        !ownsInterruptedRecovery &&
        (entry.killReconciliation !== undefined ||
          entry.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
          entry.pauseReason === "sessions_yield" ||
          typeof entry.cleanupCompletedAt === "number" ||
          (hasTerminalEvidence && !matchesRequestedInterruptedTerminal))
      ) {
        return;
      }
      if (!ownsInterruptedRecovery) {
        const endedAt =
          typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
        const outcome = withSubagentOutcomeTiming(
          { status: "error", error: completeParams.outcome.error },
          { startedAt: entry.execution.startedAt, endedAt },
        );
        entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
        entry.pauseReason = undefined;
        entry.execution = {
          ...entry.execution,
          status: "terminal",
          endedAt,
          outcome,
          interruptedAt: undefined,
          interruptionReason: undefined,
          suppressSessionEffects: suppressSessionEffects ? true : undefined,
        };
        entry.completion = {
          ...ensureCompletionState(entry),
          resultText: null,
          capturedAt: endedAt,
        };
        entry.cleanupHandled = false;
        entry.terminalOwner = "interrupted-recovery";
        mutated = true;
        try {
          params.persistOrThrow(completeParams.runId);
        } catch (error) {
          restoreEntrySnapshot(entrySnapshot);
          throw error;
        }
        // Any later delivery-payload write rolls back to this durable owner,
        // never to the pre-recovery running row.
        entrySnapshot = structuredClone(entry);
        mutated = false;
      }
    }
    sessionSuperseded = context.newerGenerationOwnsSession(currentEntry);
    if (
      completeParams.reason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.killIntent === undefined &&
      entry.endedReason !== undefined &&
      entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED &&
      entry.execution.outcome !== undefined
    ) {
      // Any finalized provider outcome is canonical. A delayed abort listener
      // must not replace success, failure, or timeout with a killed marker.
      return;
    }
    let requestedEndedAt =
      typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
    if (
      shouldPreservePublishedExplicitRunTimeout({
        entry,
      })
    ) {
      return;
    }
    const shouldDrainExistingTerminal =
      recoveryRequested ||
      isOlderEquivalentTerminalCallback({
        entry,
        endedAt: requestedEndedAt,
        outcome: completeParams.outcome,
        reason: completeParams.reason,
      });
    if (shouldDrainExistingTerminal) {
      // Preserve the newer canonical timing while allowing this duplicate
      // caller to rescue a stalled cleanup and delivery tail.
      requestedEndedAt = entry.execution.endedAt!;
      completionReason = entry.endedReason ?? completeParams.reason;
    }
    let endedAt = requestedEndedAt;
    let completionOutcome =
      shouldDrainExistingTerminal && entry.execution.outcome
        ? entry.execution.outcome
        : completeParams.outcome;
    const liveStructuredOutput = entry.collect
      ? (entry.structuredOutput ??
        peekSwarmStructuredOutput(entry.runId) ??
        (entry.swarmRunId ? peekSwarmStructuredOutput(entry.swarmRunId) : undefined))
      : undefined;
    if (!entry.structuredOutput && liveStructuredOutput) {
      entry.structuredOutput = liveStructuredOutput;
      mutated = true;
    }
    if (
      liveStructuredOutput?.structured !== undefined &&
      completionOutcome.status === "error" &&
      completionOutcome.error === "completed"
    ) {
      // Tool-only collector turns use this runner sentinel after the result is
      // durably recorded. Normalize before every task/session/hook projection.
      completionOutcome = { status: "ok" };
      completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
    }
    const observedStartedAt =
      !shouldDrainExistingTerminal &&
      typeof completeParams.startedAt === "number" &&
      Number.isFinite(completeParams.startedAt)
        ? completeParams.startedAt
        : undefined;
    const expiredDeadlineMs = recoveryRequested
      ? undefined
      : resolveExpiredExplicitRunDeadlineMs({
          entry,
          nextEndedAt: endedAt,
          observedStartedAt,
        });
    if (expiredDeadlineMs !== undefined) {
      endedAt = expiredDeadlineMs;
      completionOutcome = { status: "timeout" };
      completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
    }
    const killIntent = entry.killIntent;
    if (killIntent) {
      if (completionReason !== SUBAGENT_ENDED_REASON_KILLED && endedAt < killIntent.requestedAt) {
        entry.killIntent = undefined;
      } else {
        const killOwnsCurrentLifecycle =
          killIntent.lifecycleGeneration !== undefined &&
          isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration);
        completionReason = SUBAGENT_ENDED_REASON_KILLED;
        completionOutcome = { status: "error", error: killIntent.reason };
        entry.killIntent = undefined;
        if (killOwnsCurrentLifecycle) {
          suppressSessionEffects = false;
          entry.execution = {
            ...entry.execution,
            lifecycleGeneration: killIntent.lifecycleGeneration,
            restartRecovery: undefined,
            suppressSessionEffects: undefined,
          };
        }
        entry.killReconciliation = {
          killedAt: killIntent.requestedAt,
          suppressTaskDelivery: killIntent.suppressTaskDelivery === true ? true : undefined,
        };
      }
      mutated = true;
    }
    if (
      completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.killReconciliation === undefined
    ) {
      // Only current-version provisional kills carry reconciliation state.
      // Legacy or already-stabilized killed rows are terminal cancellation.
      return;
    }
    const isSteerRestartKill =
      completeParams.reason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.suppressAnnounceReason === "steer-restart";
    suppressTaskFinalization = isSteerRestartKill;
    if (completionReason === SUBAGENT_ENDED_REASON_KILLED && !isSteerRestartKill) {
      entry.suppressAnnounceReason = "killed";
      entry.killReconciliation ??= {
        killedAt: requestedEndedAt,
      };
      mutated = true;
    }

    if (
      completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.killReconciliation !== undefined
    ) {
      const killReconciliation = entry.killReconciliation;
      const taskResolution = params.resolveSubagentTask(entry);
      const stableTaskCancellation =
        taskResolution.lookup === "available" &&
        taskResolution.task?.status === "cancelled" &&
        !isProvisionalSubagentKillTask(taskResolution.task);
      const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(entry);
      const completionPredatesCancellation =
        typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
      if (stableTaskCancellation && !completionPredatesCancellation) {
        // tasks.cancel promotes the provisional marker to durable operator
        // intent. Only an already-durable earlier completion may reopen it.
        return;
      }
      provisionalKillSnapshot = structuredClone(currentEntry);
      // The sweeper uses marker identity to reject a concurrently replaced
      // kill generation. A completion rollback must retain the same marker.
      provisionalKillSnapshot.killReconciliation = killReconciliation;
      // Completion capture yields. Stage the provider result off-registry so
      // an unrelated persistence write cannot publish a tentative winner.
      entry = structuredClone(currentEntry);
      entry.suppressCompletionDelivery =
        killReconciliation.suppressTaskDelivery === true ? true : undefined;
      entry.suppressAnnounceReason = undefined;
      entry.killReconciliation = undefined;
      entry.cleanupHandled = false;
      entry.cleanupCompletedAt = undefined;
      clearDeliveryState(entry);
      mutated = true;
    }

    if (observedStartedAt !== undefined && entry.execution.startedAt !== observedStartedAt) {
      entry.execution = { ...entry.execution, startedAt: observedStartedAt };
      if (typeof entry.sessionStartedAt !== "number") {
        entry.sessionStartedAt = observedStartedAt;
      }
      mutated = true;
    }

    if (
      completionReason === SUBAGENT_ENDED_REASON_COMPLETE &&
      completionOutcome.status !== "error" &&
      provisionalKillSnapshot !== undefined
    ) {
      // A killed lifecycle may freeze an empty result before the canonical end
      // wins. Preserve any reply already captured by an earlier successful callback.
      const completion = ensureCompletionState(entry);
      const hasCapturedReply =
        typeof completion.resultText === "string" && completion.resultText.trim().length > 0;
      if (
        !hasCapturedReply &&
        (completion.resultText !== undefined || completion.capturedAt !== undefined)
      ) {
        completion.resultText = undefined;
        completion.capturedAt = undefined;
        mutated = true;
      }
    }
    const outcome =
      recoveryRequested && entry.execution.outcome
        ? entry.execution.outcome
        : withSubagentOutcomeTiming(completionOutcome, {
            startedAt: entry.execution.startedAt,
            endedAt,
          });
    const executionOutcome = recoveryRequested ? (entry.execution.outcome ?? outcome) : outcome;
    const retainedRestartRecovery = suppressSessionEffects
      ? entry.execution.restartRecovery
      : undefined;
    if (
      entry.execution.status !== "terminal" ||
      entry.execution.endedAt !== endedAt ||
      entry.execution.outcome !== executionOutcome ||
      entry.execution.restartRecovery !== retainedRestartRecovery ||
      entry.execution.suppressSessionEffects !== (suppressSessionEffects ? true : undefined)
    ) {
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt,
        outcome: executionOutcome,
        restartRecovery: retainedRestartRecovery,
        suppressSessionEffects: suppressSessionEffects ? true : undefined,
      };
      mutated = true;
    }
    if (entry.endedReason !== completionReason) {
      entry.endedReason = completionReason;
      mutated = true;
    }
    if (completionReason === SUBAGENT_ENDED_REASON_KILLED && entry.terminalOwner !== undefined) {
      entry.terminalOwner = undefined;
      mutated = true;
    }
    if (entry.pauseReason !== undefined) {
      entry.pauseReason = undefined;
      mutated = true;
    }

    if (completeParams.completionSnapshot) {
      const completion = ensureCompletionState(entry);
      if (
        completion.resultText !== completeParams.completionSnapshot.resultText ||
        completion.capturedAt !== completeParams.completionSnapshot.capturedAt
      ) {
        completion.resultText = completeParams.completionSnapshot.resultText;
        completion.capturedAt = completeParams.completionSnapshot.capturedAt;
        mutated = true;
      }
    }

    if (completeParams.terminalReply) {
      const completion = ensureCompletionState(entry);
      const terminalReply = mergeAgentRunTerminalReplySnapshot(
        completion.terminalReply,
        completeParams.terminalReply,
      );
      if (
        terminalReply &&
        JSON.stringify(terminalReply) !== JSON.stringify(completion.terminalReply)
      ) {
        completion.terminalReply = terminalReply;
        completion.resultText =
          terminalReply.disposition === "visible"
            ? terminalReply.text
            : terminalReply.disposition === "silent"
              ? SILENT_REPLY_TOKEN
              : null;
        completion.capturedAt = endedAt;
        mutated = true;
      }
    }

    // A newer generation may share the session key. Its transcript/reply is
    // not evidence for this older run, so reconcile only the terminal task state.
    if (recoveryRequested || sessionSuperseded) {
      const completion = ensureCompletionState(entry);
      if (completion.resultText === undefined) {
        completion.resultText = null;
        completion.capturedAt = Date.now();
        mutated = true;
      }
    } else {
      const didFreezeResult = await freezeRunResultAtCompletion(context, entry, executionOutcome);
      sessionSuperseded = context.newerGenerationOwnsSession(entry);
      if (sessionSuperseded) {
        const completion = ensureCompletionState(entry);
        completion.resultText = null;
        completion.capturedAt = Date.now();
        mutated = true;
      } else if (didFreezeResult) {
        mutated = true;
      }
    }
    if (
      entry.collect
        ? updateSwarmCollectorCompletion(entry, params.getRuntimeConfig())
        : updateSubagentArchiveAtMs(entry, params.getRuntimeConfig())
    ) {
      mutated = true;
    }
    if (provisionalKillSnapshot) {
      // Keep the tombstone's superseded generation boundary through task
      // commit. Clearing it on the canonical registry row must not let a
      // late old-run result select a newer task sharing the session key.
      const taskResolution = params.resolveSubagentTask(provisionalKillSnapshot);
      postCaptureTaskResolution = taskResolution;
      const stableTaskCancellation =
        taskResolution.lookup === "available" &&
        taskResolution.task?.status === "cancelled" &&
        !isProvisionalSubagentKillTask(taskResolution.task);
      const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(provisionalKillSnapshot);
      const completionPredatesCancellation =
        typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
      if (stableTaskCancellation && !completionPredatesCancellation) {
        // Cancellation can become durable while completion capture yields.
        // The provider transition is staged, so the live tombstone is intact.
        return;
      }
    }
    if (refreshPendingFinalDeliveryPayload(entry)) {
      mutated = true;
    }

    const opaqueTaskArbitration =
      provisionalKillSnapshot !== undefined && postCaptureTaskResolution?.lookup === "unavailable";
    // A steer abort ends one agent run but continues the same detached task.
    // The successor must remain able to publish its eventual terminal state.
    if (provisionalKillSnapshot) {
      const finalizedTasks = safeFinalizeSubagentTaskRun(params, {
        entry,
        outcome: executionOutcome,
        taskResolution: postCaptureTaskResolution,
      });
      const taskWasAbsent =
        postCaptureTaskResolution?.lookup === "available" &&
        postCaptureTaskResolution.task === undefined;
      if ((!finalizedTasks || finalizedTasks.length === 0) && !taskWasAbsent) {
        if (opaqueTaskArbitration) {
          // The optional lookup cannot prove cancellation. Let the legacy
          // runtime's own finalizer decide whether provider completion won.
          return;
        }
        const latestTaskResolution = params.resolveSubagentTask(provisionalKillSnapshot);
        const latestTask = latestTaskResolution.task;
        const stableTaskCancellation =
          latestTask?.status === "cancelled" && !isProvisionalSubagentKillTask(latestTask);
        const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(provisionalKillSnapshot);
        const completionPredatesCancellation =
          typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
        if (stableTaskCancellation && !completionPredatesCancellation) {
          return;
        }
        throw new Error("subagent task projection did not finalize");
      }

      // Task results do not auto-publish for subagents. Commit that durable,
      // idempotent projection first: after a crash the persisted kill marker
      // can replay it, while the inverse ordering could strand a provisional task.
      entry.browserCleanupDispatchedAt ??= currentEntry.browserCleanupDispatchedAt;
      if (currentEntry.killReconciliation?.suppressTaskDelivery === true) {
        entry.suppressCompletionDelivery = true;
      }
      const liveBeforeCommit = structuredClone(currentEntry);
      restoreEntrySnapshot(entry);
      entry = currentEntry;
      try {
        params.persistOrThrow(completeParams.runId);
      } catch (error) {
        restoreEntrySnapshot(liveBeforeCommit);
        throw error;
      }
      // A provider result supersedes provisional cleanup only after both
      // durable owners accept it. Rejected callbacks leave the kill tail live.
      context.bumpCleanupGeneration(entry);
    } else {
      try {
        if (mutated) {
          params.persistOrThrow(completeParams.runId);
        }
      } catch (error) {
        restoreEntrySnapshot(entrySnapshot);
        throw error;
      }
      if (!suppressTaskFinalization) {
        safeFinalizeSubagentTaskRun(params, {
          entry,
          outcome: executionOutcome,
        });
      }
    }
    terminalGeneration = context.bumpTerminalGeneration(entry);
  } finally {
    // Only the canonical state/capture transition is serialized. Cleanup
    // remains re-entrant so a stalled browser close cannot strand a duplicate callback.
    releaseCompletionLock();
  }

  if (!entry) {
    return;
  }
  await completeTerminalEffects(context, {
    completeParams,
    completionReason,
    entry,
    mutated,
    sessionSuperseded,
    suppressSessionEffects,
    terminalGeneration,
    loadCleanupBrowserSessionsForLifecycleEnd:
      params.loadCleanupBrowserSessionsForLifecycleEnd ?? loadCleanupBrowserSessionsForLifecycleEnd,
  });
}
