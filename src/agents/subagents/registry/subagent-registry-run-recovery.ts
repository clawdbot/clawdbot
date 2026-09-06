import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
/** Owns steer replacement and restart-recovery receipt transitions. */
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { prepareCanonicalTaskActivation } from "../../../tasks/task-backing-authority-write.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  normalizeSubagentRunState,
} from "./subagent-delivery-state.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { commitSubagentTaskReplacement } from "./subagent-registry-replacement-store.js";
import { SubagentWaitManager } from "./subagent-registry-run-wait.js";
import type {
  RequesterSettleWakeState,
  SubagentRestartRecoveryReceipt,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-session-metrics.js";

const log = createSubsystemLogger("agents/subagent-registry");

export class SubagentRecoveryManager extends SubagentWaitManager {
  private readonly unpersistedAcceptances = new WeakMap<
    SubagentRunRecord,
    SubagentRestartRecoveryReceipt
  >();

  readonly replaceSubagentRunAfterSteer = (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    expected?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    allowEndedSource?: boolean;
    preserveFrozenResultFallback?: boolean;
    // A follow-up that continues a paused run inherits the original requester's
    // wake credential. An operator steer intentionally drops it: the operator is
    // already the live audience, so re-arming would wake a requester that is no
    // longer waiting. Without this the yielded parent loses its only wake path
    // and its settle batch defers with nothing recording why.
    preserveRequesterSettleWake?: boolean;
    transcriptTarget?: AgentRunSessionTarget;
    task?: string;
    restartRecovery?: SubagentRestartRecoveryReceipt;
    lifecycleGeneration?: string;
    persistenceFailure?: "return-false" | "throw";
    gatewayContextResolver?: GatewayContextResolver;
  }): boolean => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }
    if (
      replaceParams.lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(replaceParams.lifecycleGeneration)
    ) {
      return false;
    }

    const previous = this.options.runs.get(previousRunId);
    if (replaceParams.expected && previous !== replaceParams.expected) {
      return false;
    }
    if (
      replaceParams.expected &&
      previous &&
      ((typeof previous.execution.endedAt === "number" &&
        replaceParams.allowEndedSource !== true) ||
        previous.killReconciliation !== undefined ||
        previous.killIntent !== undefined)
    ) {
      return false;
    }
    const source = previous ?? replaceParams.fallback;
    if (!source) {
      return false;
    }
    const sourceSnapshot = structuredClone(source);

    const now = Date.now();
    const generation = nextSubagentRunGeneration(
      [...this.options.getRunsForChildSession(source.childSessionKey), source],
      source.childSessionKey,
    );
    const cfg = this.options.getRuntimeConfig();
    const acceptedReceipt = this.unpersistedAcceptances.get(source);
    const acceptanceSessionTarget =
      acceptedReceipt && this.currentRunOwnsSession(source)
        ? {
            storePath: resolveSessionStorePathCore(cfg.session?.store, {
              agentId: resolveAgentIdFromSessionKey(source.childSessionKey),
            }),
            sessionKey: source.childSessionKey,
            clone: false,
          }
        : undefined;
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
    const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
    const accumulatedRuntimeMs =
      getSubagentSessionRuntimeMs(
        source,
        typeof source.execution.endedAt === "number" ? source.execution.endedAt : now,
      ) ?? 0;

    const sourceCompletion = ensureCompletionState(source);
    // Prefer the caller-supplied task (the text actually dispatched to the
    // child session during steer/wake/orphan-resume) over the previous run's
    // stale `task`. Falling back to the prior task preserves behavior for any
    // caller that does not pass a replacement message. The orphan-session
    // registry restart recovery flow rewraps the persisted `task` into the
    // `[Subagent Task]` block after a gateway restart; using stale text would
    // silently re-run the original instruction and lose the user's steer
    // update.
    const nextTask =
      typeof replaceParams.task === "string" && replaceParams.task.length > 0
        ? replaceParams.task
        : source.task;
    // The frozen batch is addressed by runId. Adoption retires the previous id,
    // so an unmapped membership list would drop this row from its own batch and
    // let the wave complete without ever waking the requester.
    const sourceRequesterSettleWake = replaceParams.preserveRequesterSettleWake
      ? source.requesterSettleWake
      : undefined;
    const inheritedRequesterSettleWake: RequesterSettleWakeState | undefined =
      sourceRequesterSettleWake
        ? {
            ...sourceRequesterSettleWake,
            ...(sourceRequesterSettleWake.batchRunIds
              ? {
                  batchRunIds: sourceRequesterSettleWake.batchRunIds
                    .map((runId) => (runId === previousRunId ? nextRunId : runId))
                    .toSorted(),
                }
              : {}),
          }
        : undefined;
    const next: SubagentRunRecord = normalizeSubagentRunState({
      ...source,
      runId: nextRunId,
      // Materialize the legacy run-id fallback so later replacements keep the
      // same canonical task owner after this source row is retired.
      taskRunId: source.taskRunId ?? source.runId,
      task: nextTask,
      generation,
      createdAt: now,
      sessionStartedAt,
      accumulatedRuntimeMs,
      endedReason: undefined,
      pauseReason: undefined,
      endedHookEmittedAt: undefined,
      browserCleanupDispatchedAt: undefined,
      deleteCleanupDispatchedAt: undefined,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: inheritedRequesterSettleWake,
      execution: {
        status: "running",
        startedAt: now,
        lifecycleGeneration:
          replaceParams.lifecycleGeneration ??
          replaceParams.restartRecovery?.lifecycleGeneration ??
          getAgentEventLifecycleGeneration(),
        transcriptTarget: replaceParams.transcriptTarget,
        restartRecovery: replaceParams.restartRecovery,
      },
      swarmLaunchPending: false,
      completion: {
        required: source.expectsCompletionMessage === true,
        fallbackResultText: preserveFrozenResultFallback ? sourceCompletion.resultText : undefined,
        fallbackCapturedAt: preserveFrozenResultFallback ? sourceCompletion.capturedAt : undefined,
      },
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      suppressAnnounceReason: undefined,
      terminalOwner: undefined,
      killReconciliation: undefined,
      killIntent: undefined,
      suppressCompletionDelivery: undefined,
      delivery: {
        status: source.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      spawnMode,
      archiveAtMs: undefined,
      runTimeoutSeconds,
    });
    bindGatewayContextResolver(
      next,
      replaceParams.gatewayContextResolver ?? getGatewayContextResolver(source),
    );
    clearDeliveryState(next);

    const taskActivation =
      source.expectsCompletionMessage === false
        ? undefined
        : prepareCanonicalTaskActivation({
            runtime: "subagent",
            childSessionKey: next.childSessionKey,
            runId: source.taskRunId ?? source.runId,
            detail: createSubagentTaskBackingDetail(generation),
            startedAt: now,
            // An admitted kill owns the provisional task projection until its
            // reconciliation settles. An unclaimed marker yields to the admitted
            // successor and must not leave its task cancelled.
            preserveProvisionalCancellation:
              source.killReconciliation?.taskCancellationAccepted === true,
          });

    if (previousRunId !== nextRunId) {
      this.options.runs.delete(previousRunId);
    }
    this.options.runs.set(nextRunId, next);
    const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(next);
    const changedRunIds = [
      previousRunId,
      nextRunId,
      ...[...killReconciliationSnapshots.keys()].map((entry) => entry.runId),
    ];
    const rollbackReplacement = () => {
      this.restoreKillReconciliationSnapshots(killReconciliationSnapshots);
      this.options.runs.delete(nextRunId);
      this.options.runs.set(previousRunId, source);
    };
    const adoptSuccessorOwner = () => {
      if (!taskActivation) {
        subagentRuns.commitOwnership(next);
      }
      if (previousRunId !== nextRunId) {
        this.options.clearPendingLifecycleError(previousRunId);
        this.options.resumedRuns.delete(previousRunId);
        if (this.shouldDeleteAttachments(source)) {
          void safeRemoveAttachmentsDir(source);
        }
        if (
          source.execution.transcriptTarget &&
          source.execution.transcriptTarget !== replaceParams.transcriptTarget
        ) {
          void removeInternalSessionEffectsSession(source.execution.transcriptTarget);
        }
      }
      this.options.ensureListener();
      // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
      this.options.startSweeper();
      if (!next.execution.restartRecovery) {
        void this.waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
      }
    };
    const canReconcileAcceptedReceipt = () => {
      // Staging replaces the map entry before commit. Only this exact
      // live acceptance may bridge its failed write, never a restored copy.
      if (
        !acceptedReceipt ||
        !acceptanceSessionTarget ||
        this.unpersistedAcceptances.get(source) !== acceptedReceipt ||
        source.execution.restartRecovery !== acceptedReceipt ||
        replaceParams.restartRecovery !== acceptedReceipt ||
        acceptedReceipt.idempotencyKey !== nextRunId ||
        !acceptedReceipt.lifecycleGeneration ||
        !isAgentEventLifecycleGenerationCurrent(acceptedReceipt.lifecycleGeneration) ||
        this.options.runs.get(nextRunId) !== next ||
        source.generation !== sourceSnapshot.generation ||
        source.createdAt !== sourceSnapshot.createdAt ||
        typeof source.execution.endedAt === "number" ||
        source.killIntent ||
        source.killReconciliation ||
        source.pauseReason === "sessions_yield" ||
        source.suppressAnnounceReason === "steer-restart" ||
        Array.from(this.options.getRunsForChildSession(source.childSessionKey)).some(
          (candidate) =>
            candidate !== next && compareSubagentRunGeneration(candidate, sourceSnapshot) > 0,
        )
      ) {
        return false;
      }
      const session = loadSessionEntryReadOnly(acceptanceSessionTarget);
      return (
        session?.sessionId === acceptedReceipt.sessionId &&
        (acceptedReceipt.sessionLifecycleRevision === undefined ||
          session.lifecycleRevision === acceptedReceipt.sessionLifecycleRevision)
      );
    };
    const persistReplacement = (): void => {
      if (taskActivation) {
        commitSubagentTaskReplacement({
          runs: this.options.runs,
          changedRunIds,
          source: sourceSnapshot,
          successor: next,
          task: taskActivation,
          canReconcileAcceptedReceipt,
        });
        return;
      }
      this.options.persistOrThrow(...changedRunIds);
    };
    try {
      persistReplacement();
    } catch (error) {
      rollbackReplacement();
      log.warn("failed to persist replacement subagent recovery run; restored source lease", {
        error,
        previousRunId,
        nextRunId,
      });
      if (
        replaceParams.persistenceFailure === "return-false" ||
        replaceParams.lifecycleGeneration !== undefined
      ) {
        return false;
      }
      throw error;
    }
    this.unpersistedAcceptances.delete(source);
    // Atomic publication can synchronously trigger another replacement. Do not
    // start stale cleanup or completion work after that newer owner takes over.
    if (this.options.runs.get(nextRunId) !== next) {
      return true;
    }
    adoptSuccessorOwner();
    return true;
  };

  readonly reserveSubagentRestartRecoveryLaunch = (reserveParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId: string;
    sessionMarker: string;
    sessionLifecycleRevision?: string;
    idempotencyKey: string;
  }): string | undefined => {
    const runId = reserveParams.runId.trim();
    const sessionId = reserveParams.sessionId.trim();
    const sessionMarker = reserveParams.sessionMarker.trim();
    const idempotencyKey = reserveParams.idempotencyKey.trim();
    const entry = this.options.runs.get(runId);
    if (
      !runId ||
      !sessionId ||
      !sessionMarker ||
      !idempotencyKey ||
      entry !== reserveParams.expected ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    const existing = entry.execution.restartRecovery;
    if (existing?.sessionMarker === sessionMarker && existing.idempotencyKey.trim().length > 0) {
      return existing.idempotencyKey;
    }
    const previousLease = existing;
    const previousCollectorLaunch = {
      idempotencyKey: entry.swarmLaunchIdempotencyKey,
      pending: entry.swarmLaunchPending,
    };
    entry.execution.restartRecovery = {
      sessionId,
      sessionMarker,
      sessionLifecycleRevision: reserveParams.sessionLifecycleRevision,
      idempotencyKey,
      phase: "reserved",
    };
    if (entry.collect === true) {
      entry.swarmLaunchIdempotencyKey = idempotencyKey;
      entry.swarmLaunchPending = true;
    }
    try {
      // The exact source row owns this dispatch identity before Gateway can
      // accept it. A lost response can then replay the same logical run.
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = previousLease;
      entry.swarmLaunchIdempotencyKey = previousCollectorLaunch.idempotencyKey;
      entry.swarmLaunchPending = previousCollectorLaunch.pending;
      throw error;
    }
    return idempotencyKey;
  };

  readonly markSubagentRestartRecoveryLaunchAttempted = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
    lifecycleGeneration: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== markParams.expected ||
      receipt?.sessionMarker !== markParams.sessionMarker ||
      receipt.idempotencyKey !== markParams.idempotencyKey ||
      !isAgentEventLifecycleGenerationCurrent(markParams.lifecycleGeneration) ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    if (receipt.phase !== "reserved") {
      return receipt;
    }
    const attempted = {
      ...receipt,
      phase: "attempted" as const,
      lifecycleGeneration: markParams.lifecycleGeneration,
    };
    entry.execution.restartRecovery = attempted;
    try {
      // This is the at-most-once boundary. After it commits, recovery adopts
      // this run identity instead of replaying provider-visible side effects.
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return attempted;
  };

  readonly abandonSubagentRestartRecoveryLaunch = (abandonParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = abandonParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== abandonParams.expected ||
      receipt?.sessionMarker !== abandonParams.sessionMarker ||
      receipt.idempotencyKey !== abandonParams.idempotencyKey ||
      (receipt.phase !== "attempted" && receipt.phase !== "consumed")
    ) {
      return receipt?.phase === "abandoned";
    }
    const abandoned = { ...receipt, phase: "abandoned" as const };
    entry.execution.restartRecovery = abandoned;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return true;
  };

  readonly markSubagentRestartRecoveryLaunchConsumed = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== markParams.expected ||
      receipt?.sessionMarker !== markParams.sessionMarker ||
      receipt.idempotencyKey !== markParams.idempotencyKey ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    if (receipt.phase !== "attempted") {
      return receipt;
    }
    const consumed = { ...receipt, phase: "consumed" as const };
    entry.execution.restartRecovery = consumed;
    // Handoff consumption is irreversible in this process. A failed write must
    // leave the in-memory fact available for the definitive Gateway response.
    this.options.persistOrThrow(runId);
    return consumed;
  };

  readonly markSubagentRestartRecoveryLaunchAccepted = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== markParams.expected ||
      receipt?.sessionMarker !== markParams.sessionMarker ||
      receipt.idempotencyKey !== markParams.idempotencyKey ||
      typeof entry.execution.endedAt === "number" ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      entry.suppressAnnounceReason === "steer-restart"
    ) {
      return undefined;
    }
    if (receipt.phase !== "consumed") {
      return receipt;
    }
    const accepted = Object.freeze({ ...receipt, phase: "accepted" as const });
    entry.execution.restartRecovery = accepted;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      // Gateway acceptance is irreversible. Keep the in-memory fact and let the
      // caller immediately attempt the strict successor remap.
      this.unpersistedAcceptances.set(entry, accepted);
      log.warn("failed to persist accepted subagent restart recovery receipt", {
        error,
        runId,
      });
    }
    return accepted;
  };

  readonly clearAcceptedSubagentRestartRecovery = (clearParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId: string;
    idempotencyKey: string;
    pendingNoticeIdempotencyKey?: string;
  }): boolean => {
    const runId = clearParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== clearParams.expected ||
      receipt?.phase !== "accepted" ||
      receipt.sessionId !== clearParams.sessionId ||
      receipt.idempotencyKey !== clearParams.idempotencyKey
    ) {
      return false;
    }
    const previousNotice = entry.resumptionNotice;
    entry.execution.restartRecovery = undefined;
    if (clearParams.pendingNoticeIdempotencyKey) {
      entry.resumptionNotice = {
        idempotencyKey: clearParams.pendingNoticeIdempotencyKey,
      };
    }
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      entry.resumptionNotice = previousNotice;
      throw error;
    }
    return true;
  };

  readonly clearPendingSubagentRecoveryNotice = (noticeParams: {
    runId: string;
    expected: SubagentRunRecord;
    idempotencyKey: string;
  }): boolean => {
    const runId = noticeParams.runId.trim();
    const entry = this.options.runs.get(runId);
    if (
      !runId ||
      entry !== noticeParams.expected ||
      entry.resumptionNotice?.idempotencyKey !== noticeParams.idempotencyKey
    ) {
      return false;
    }
    const previous = entry.resumptionNotice;
    entry.resumptionNotice = undefined;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.resumptionNotice = previous;
      throw error;
    }
    return true;
  };

  readonly resumeSettledSubagentRestartRecovery = (resumeParams: {
    runId: string;
    expected: SubagentRunRecord;
  }): boolean => {
    const runId = resumeParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (!runId || entry !== resumeParams.expected || receipt !== undefined) {
      return false;
    }
    if (entry.killIntent || entry.killReconciliation) {
      return true;
    }
    this.options.resumedRuns.delete(runId);
    this.options.resumeSubagentRun(runId);
    return true;
  };

  readonly resetSubagentRestartRecoveryLaunchAttempt = (resetParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = resetParams.runId.trim();
    const entry = this.options.runs.get(runId);
    const receipt = entry?.execution.restartRecovery;
    if (
      !runId ||
      entry !== resetParams.expected ||
      receipt?.sessionMarker !== resetParams.sessionMarker ||
      receipt.idempotencyKey !== resetParams.idempotencyKey ||
      receipt.phase !== "attempted"
    ) {
      return receipt?.phase === "reserved";
    }
    const reserved = {
      sessionId: receipt.sessionId,
      sessionMarker: receipt.sessionMarker,
      sessionLifecycleRevision: receipt.sessionLifecycleRevision,
      idempotencyKey: receipt.idempotencyKey,
      phase: "reserved" as const,
    };
    entry.execution.restartRecovery = reserved;
    try {
      this.options.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return true;
  };
}
