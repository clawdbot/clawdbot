/**
 * Subagent run manager.
 *
 * Waits for child runs, records terminal outcomes, creates task-runtime entries, and archives completed sessions.
 */
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type DetachedTaskFindResult,
} from "../tasks/detached-task-runtime-contract.js";
import {
  createQueuedTaskRun,
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  startTaskRunByRunId,
} from "../tasks/detached-task-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "./agent-run-terminal-outcome.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import { isRecoverableAgentWaitError, waitForAgentRun } from "./run-wait.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  normalizeSubagentRunState,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveFinalizedSubagentTaskState,
  resolveKilledSubagentTaskEndedAt,
} from "./subagent-registry-completion.js";
import {
  persistSubagentSessionTiming,
  resolveSubagentArchiveAtMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type {
  SubagentProgressOrigin,
  SubagentRunRecord,
  SwarmQueuedLaunch,
} from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";
import { resolveSubagentRunDeadlineMs } from "./subagent-run-timeout.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-session-metrics.js";
import type { SubagentSessionCompletion } from "./subagent-session-reconciliation.js";
import { updateSwarmCollectorCompletion } from "./swarm-collector.js";
import { isSwarmRunQueued, removeQueuedSwarmRun } from "./swarm-scheduler.js";

const log = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = isFastTestRuntimeEnv() ? 25 : 5_000;
const WAIT_TIMEOUT_DEADLINE_SKEW_MS = 250;

function shouldDeleteAttachments(entry: SubagentRunRecord) {
  return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
}

function resolveSwarmWaitOwnerSessionKeys(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  requesterSessionKey: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited = new Set<string>();
  let currentSessionKey = requesterSessionKey.trim();
  while (currentSessionKey && !visited.has(currentSessionKey)) {
    visited.add(currentSessionKey);
    ownerSessionKeys.push(currentSessionKey);
    let latestOwner: SubagentRunRecord | undefined;
    for (const candidate of runs.values()) {
      if (
        candidate.childSessionKey === currentSessionKey &&
        (!latestOwner || compareSubagentRunGeneration(candidate, latestOwner) > 0)
      ) {
        latestOwner = candidate;
      }
    }
    currentSessionKey =
      latestOwner?.controllerSessionKey?.trim() || latestOwner?.requesterSessionKey.trim() || "";
  }
  return ownerSessionKeys;
}

function resolveHardRunTimeoutEndedAt(
  entry: SubagentRunRecord,
  now: number,
  observedStartedAt?: number,
): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(entry, observedStartedAt);
  if (deadlineMs === undefined) {
    return undefined;
  }
  return now + WAIT_TIMEOUT_DEADLINE_SKEW_MS >= deadlineMs ? deadlineMs : undefined;
}

function resolveCompletionAfterHardRunDeadline(params: {
  entry: SubagentRunRecord;
  observedStartedAt?: number;
  observedEndedAt?: number;
  now: number;
}): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry, params.observedStartedAt);
  if (deadlineMs === undefined) {
    return undefined;
  }
  const observedEndedAt =
    typeof params.observedEndedAt === "number" && Number.isFinite(params.observedEndedAt)
      ? params.observedEndedAt
      : params.now;
  return observedEndedAt > deadlineMs ? deadlineMs : undefined;
}

function resolveWaitTimeoutMsForRun(
  entry: SubagentRunRecord,
  waitTimeoutMs: number,
  now: number,
): number {
  const normalizedWaitTimeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
  const deadlineMs = resolveSubagentRunDeadlineMs(entry);
  if (deadlineMs === undefined) {
    return normalizedWaitTimeoutMs;
  }
  return Math.max(1, Math.min(normalizedWaitTimeoutMs, deadlineMs - now));
}

export function markSubagentRunPausedAfterYield(params: {
  entry: SubagentRunRecord;
  startedAt?: number;
  endedAt?: number;
  now?: number;
}): boolean {
  const { entry } = params;
  if (
    entry.terminalOwner === "interrupted-recovery" ||
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
    entry.suppressAnnounceReason === "killed" ||
    (entry.cleanup === "delete" && Number.isFinite(entry.deleteCleanupDispatchedAt))
  ) {
    // agent.wait and lifecycle events can report the old yield after control
    // killed the run. Once delete dispatch starts, reviving the row would expose
    // a live run whose backing session may already be gone.
    return false;
  }
  let mutated = false;
  if (typeof params.startedAt === "number" && entry.startedAt !== params.startedAt) {
    entry.startedAt = params.startedAt;
    if (typeof entry.sessionStartedAt !== "number") {
      entry.sessionStartedAt = params.startedAt;
    }
    mutated = true;
  }
  const endedAt = typeof params.endedAt === "number" ? params.endedAt : (params.now ?? Date.now());
  if (entry.endedAt !== endedAt) {
    entry.endedAt = endedAt;
    mutated = true;
  }
  if (entry.pauseReason !== "sessions_yield") {
    entry.pauseReason = "sessions_yield";
    mutated = true;
  }
  if (entry.outcome !== undefined) {
    entry.outcome = undefined;
    mutated = true;
  }
  if (entry.endedReason !== undefined) {
    entry.endedReason = undefined;
    mutated = true;
  }
  if (entry.cleanupHandled === true) {
    entry.cleanupHandled = false;
    mutated = true;
  }
  if (entry.cleanupCompletedAt !== undefined) {
    entry.cleanupCompletedAt = undefined;
    mutated = true;
  }
  if (entry.delivery !== undefined) {
    clearDeliveryState(entry);
    mutated = true;
  }
  const completion = ensureCompletionState(entry);
  if (completion.resultText !== undefined) {
    completion.resultText = undefined;
    completion.capturedAt = undefined;
    mutated = true;
  }
  return mutated;
}

export type RegisterSubagentRunParams = {
  runId: string;
  requesterTurnRunId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  collect?: boolean;
  swarmRequesterSessionKey?: string;
  swarmLaunchIdempotencyKey?: string;
  swarmLaunchReplayKey?: string;
  swarmLaunchRequestFingerprint?: string;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  queuedLaunch?: SwarmQueuedLaunch;
  queued?: boolean;
};

export function createSubagentRunManager(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist(): void;
  persistOrThrow(): void;
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
  clearPendingLifecycleTimeout(runId: string): void;
  resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number): number;
  scheduleOrphanRecovery(args?: { delayMs?: number; maxRetries?: number }): void;
  resolveSubagentSessionCompletion(args: {
    childSessionKey: string;
    fallbackEndedAt: number;
    notBeforeMs?: number;
  }): SubagentSessionCompletion | null;
  resolveSubagentSessionStartedAt(args: {
    childSessionKey: string;
    notBeforeMs?: number;
  }): number | undefined;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted" | "released";
    agentDir?: string;
    workspaceDir?: string;
  }): Promise<void>;
  completeCleanupBookkeeping(args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
    preserveTranscript?: boolean;
    provisionalKill?: boolean;
  }): void;
  completeSubagentRun(args: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
    startedAt?: number;
  }): Promise<void>;
  resolveSubagentTask(entry: SubagentRunRecord): DetachedTaskFindResult;
}) {
  const markOlderKillReconciliationsSuperseded = (next: SubagentRunRecord) => {
    const snapshots = new Map<SubagentRunRecord, SubagentRunRecord["killReconciliation"]>();
    for (const candidate of params.runs.values()) {
      if (
        candidate.runId === next.runId ||
        candidate.childSessionKey !== next.childSessionKey ||
        compareSubagentRunGeneration(candidate, next) >= 0 ||
        !candidate.killReconciliation
      ) {
        continue;
      }
      snapshots.set(candidate, structuredClone(candidate.killReconciliation));
      candidate.killReconciliation.supersededAt = Math.min(
        candidate.killReconciliation.supersededAt ?? next.createdAt,
        next.createdAt,
      );
    }
    return snapshots;
  };

  const currentRunOwnsSession = (entry: SubagentRunRecord): boolean =>
    params.runs.get(entry.runId) === entry &&
    entry.killReconciliation?.supersededAt === undefined &&
    !Array.from(params.runs.values()).some(
      (candidate) =>
        candidate.childSessionKey === entry.childSessionKey &&
        compareSubagentRunGeneration(candidate, entry) > 0,
    );

  const restoreKillReconciliationSnapshots = (
    snapshots: Map<SubagentRunRecord, SubagentRunRecord["killReconciliation"]>,
  ) => {
    for (const [entry, snapshot] of snapshots) {
      entry.killReconciliation = snapshot;
    }
  };

  const waitForSubagentCompletion = async (
    runId: string,
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
    capWaitToStoredDeadline = false,
  ) => {
    let completionForRetry: Parameters<typeof params.completeSubagentRun>[0] | undefined;
    const scheduleWaitRetry = (entry: SubagentRunRecord, reason: string, error?: string) => {
      params.scheduleOrphanRecovery({ delayMs: 1_000 });
      const scheduledEntry = entry;
      setTimeout(() => {
        const current = params.runs.get(runId);
        if (!current || current !== scheduledEntry || typeof current.endedAt === "number") {
          return;
        }
        void waitForSubagentCompletion(runId, waitTimeoutMs, scheduledEntry, true);
      }, RECOVERABLE_WAIT_RETRY_DELAY_MS).unref?.();
      log.info(reason, {
        runId,
        childSessionKey: entry.childSessionKey,
        ...(error ? { error } : {}),
      });
    };
    try {
      const entryBeforeWait = params.runs.get(runId);
      if (!entryBeforeWait || (expectedEntry && entryBeforeWait !== expectedEntry)) {
        return;
      }
      const waitStartedAt = Date.now();
      const timeoutMs = capWaitToStoredDeadline
        ? resolveWaitTimeoutMsForRun(entryBeforeWait, waitTimeoutMs, waitStartedAt)
        : Math.max(1, Math.floor(waitTimeoutMs));
      const wait = await waitForAgentRun({
        runId,
        timeoutMs,
        callGateway: params.callGateway,
      });
      const entry = params.runs.get(runId);
      if (!entry || (expectedEntry && entry !== expectedEntry)) {
        return;
      }
      if (wait.status === "pending") {
        return;
      }
      const waitTerminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(wait);
      const waitBlocked = waitTerminalOutcome?.reason === "blocked";
      const waitAborted =
        waitTerminalOutcome?.reason === "aborted" || waitTerminalOutcome?.reason === "cancelled";
      const waitStatus = waitTerminalOutcome?.status ?? wait.status;
      if (wait.yielded === true && waitStatus !== "timeout" && !waitBlocked) {
        params.clearPendingLifecycleError(runId);
        params.clearPendingLifecycleTimeout(runId);
        if (
          markSubagentRunPausedAfterYield({
            entry,
            startedAt: wait.startedAt,
            endedAt: wait.endedAt,
          })
        ) {
          params.persist();
        }
        return;
      }
      if (waitStatus === "error" && !waitAborted && isRecoverableAgentWaitError(wait.error)) {
        scheduleWaitRetry(entry, "subagent wait interrupted; scheduling recovery", wait.error);
        return;
      }
      const observedStartedAt =
        typeof wait.startedAt === "number" && Number.isFinite(wait.startedAt)
          ? wait.startedAt
          : params.resolveSubagentSessionStartedAt({
              childSessionKey: entry.childSessionKey,
              notBeforeMs: entry.startedAt ?? entry.createdAt,
            });
      const completeAsRunTimeout = async (endedAt?: number, startedAt?: number) => {
        const timeoutCompletion: Parameters<typeof params.completeSubagentRun>[0] = {
          runId,
          outcome: { status: "timeout" },
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
        };
        if (typeof endedAt === "number") {
          timeoutCompletion.endedAt = endedAt;
        }
        if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
          timeoutCompletion.startedAt = startedAt;
        }
        completionForRetry = timeoutCompletion;
        await params.completeSubagentRun(completionForRetry);
      };
      if (waitStatus === "timeout") {
        const isTerminalWaitTimeout =
          typeof wait.endedAt === "number" ||
          typeof wait.stopReason === "string" ||
          typeof wait.livenessState === "string";
        const now = Date.now();
        // A plain agent.wait timeout has no terminal snapshot. For explicit
        // subagent run timeouts, the stored run deadline is the completion
        // contract so parent sessions are woken instead of retrying forever.
        const hardRunTimeoutEndedAt = resolveHardRunTimeoutEndedAt(entry, now, observedStartedAt);
        const completion = params.resolveSubagentSessionCompletion({
          childSessionKey: entry.childSessionKey,
          fallbackEndedAt:
            typeof wait.endedAt === "number" ? wait.endedAt : (hardRunTimeoutEndedAt ?? now),
          notBeforeMs: observedStartedAt ?? entry.startedAt ?? entry.createdAt,
        });
        if (completion) {
          const completionStartedAt = observedStartedAt ?? completion.startedAt;
          const completionAfterDeadline = resolveCompletionAfterHardRunDeadline({
            entry,
            observedStartedAt: completionStartedAt,
            observedEndedAt: completion.endedAt,
            now,
          });
          if (completionAfterDeadline !== undefined) {
            await completeAsRunTimeout(completionAfterDeadline, completionStartedAt);
            return;
          }
          completionForRetry = {
            runId,
            endedAt: completion.endedAt,
            outcome: completion.outcome,
            reason: completion.reason,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            triggerCleanup: true,
            startedAt: completionStartedAt,
          };
          await params.completeSubagentRun(completionForRetry);
          return;
        }
        if (isTerminalWaitTimeout || hardRunTimeoutEndedAt !== undefined) {
          let timeoutEndedAt =
            typeof wait.endedAt === "number" ? wait.endedAt : hardRunTimeoutEndedAt;
          const timeoutAfterDeadline = resolveCompletionAfterHardRunDeadline({
            entry,
            observedStartedAt,
            observedEndedAt: timeoutEndedAt,
            now,
          });
          if (timeoutAfterDeadline !== undefined) {
            timeoutEndedAt = timeoutAfterDeadline;
          }
          await completeAsRunTimeout(timeoutEndedAt, observedStartedAt);
          return;
        }
        if (observedStartedAt !== undefined && entry.startedAt !== observedStartedAt) {
          entry.startedAt = observedStartedAt;
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = observedStartedAt;
          }
          params.persist();
        }
        scheduleWaitRetry(
          entry,
          "subagent wait timed out; deferring terminal state until session reconciliation",
        );
        return;
      }
      const completionAfterDeadline = resolveCompletionAfterHardRunDeadline({
        entry,
        observedStartedAt,
        observedEndedAt: wait.endedAt,
        now: Date.now(),
      });
      if (completionAfterDeadline !== undefined) {
        await completeAsRunTimeout(completionAfterDeadline, observedStartedAt);
        return;
      }
      const endedAt = typeof wait.endedAt === "number" ? wait.endedAt : Date.now();
      const rawWaitError = typeof wait.error === "string" ? wait.error : undefined;
      const waitError = waitAborted
        ? "subagent run terminated"
        : (waitTerminalOutcome?.error ?? rawWaitError);
      const baseOutcome: SubagentRunOutcome =
        waitStatus === "error" ? { status: "error", error: waitError } : { status: "ok" };
      const outcome = withSubagentOutcomeTiming(baseOutcome, {
        startedAt: observedStartedAt ?? entry.startedAt,
        endedAt,
      });
      completionForRetry = {
        runId,
        endedAt,
        outcome,
        reason: waitAborted
          ? SUBAGENT_ENDED_REASON_KILLED
          : waitStatus === "error"
            ? SUBAGENT_ENDED_REASON_ERROR
            : SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        startedAt: observedStartedAt,
      };
      await params.completeSubagentRun(completionForRetry);
    } catch (error) {
      const current = params.runs.get(runId);
      log.warn("failed to complete subagent run; retrying completion", {
        runId,
        childSessionKey: current?.childSessionKey ?? expectedEntry?.childSessionKey,
        error,
      });
      if (!current) {
        return;
      }
      if (completionForRetry) {
        try {
          await params.completeSubagentRun(completionForRetry);
          return;
        } catch (retryError) {
          log.warn("failed to complete subagent run after retry; retrying ended cleanup", {
            runId,
            childSessionKey: current.childSessionKey,
            error: retryError,
          });
        }
      }
      if (
        typeof current.endedAt === "number" &&
        !current.cleanupCompletedAt &&
        current.pauseReason !== "sessions_yield"
      ) {
        current.cleanupHandled = false;
        params.resumedRuns.delete(runId);
        params.resumeSubagentRun(runId);
      } else if (completionForRetry && typeof current.endedAt !== "number") {
        params.scheduleOrphanRecovery({ delayMs: 1_000 });
      }
    }
  };

  const markSubagentRunForSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason === "steer-restart") {
      return true;
    }
    entry.suppressAnnounceReason = "steer-restart";
    params.persist();
    return true;
  };

  const clearSubagentRunSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason !== "steer-restart") {
      return true;
    }
    if (typeof entry.endedAt === "number") {
      const taskResolution = params.resolveSubagentTask(entry);
      const task = taskResolution.lookup === "available" ? taskResolution.task : undefined;
      const terminal =
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED
          ? {
              status: "cancelled" as const,
              endedAt: entry.endedAt,
              lastEventAt: entry.endedAt,
              error: "Subagent restart failed after the prior run was interrupted.",
            }
          : resolveFinalizedSubagentTaskState(entry);
      if (terminal) {
        const targetRunId = task?.runId ?? entry.taskRunId ?? entry.runId;
        const targetSessionKey = task?.childSessionKey ?? entry.childSessionKey;
        try {
          finalizeTaskRunByRunId({
            runId: targetRunId,
            runtime: "subagent",
            sessionKey: targetSessionKey,
            ...terminal,
            suppressDelivery: true,
          });
        } catch (err) {
          // A task-runtime failure must not leave the interrupted run's
          // announcement and cleanup path permanently suppressed.
          log.warn("failed to finalize abandoned steer-restart task run", {
            err,
            runId: targetRunId,
            childSessionKey: targetSessionKey,
          });
        }
      }
    }
    entry.suppressAnnounceReason = undefined;
    params.persist();
    // If the interrupted run already finished while suppression was active, retry
    // cleanup now so completion output is not lost when restart dispatch fails.
    params.resumedRuns.delete(key);
    if (typeof entry.endedAt === "number" && !entry.cleanupCompletedAt) {
      params.resumeSubagentRun(key);
    }
    return true;
  };

  const replaceSubagentRunAfterSteer = (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    preserveFrozenResultFallback?: boolean;
    transcriptTarget?: AgentRunSessionTarget;
    task?: string;
  }) => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }

    const previous = params.runs.get(previousRunId);
    const source = previous ?? replaceParams.fallback;
    if (!source) {
      return false;
    }

    const now = Date.now();
    const generation = nextSubagentRunGeneration(
      [...params.runs.values(), source],
      source.childSessionKey,
    );
    const cfg = params.getRuntimeConfig();
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const archiveAtMs = resolveSubagentArchiveAtMs({
      cfg,
      now,
      spawnMode,
      cleanup: source.cleanup,
      collect: source.collect,
    });
    const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
    const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
    const accumulatedRuntimeMs =
      getSubagentSessionRuntimeMs(
        source,
        typeof source.endedAt === "number" ? source.endedAt : now,
      ) ?? 0;

    const sourceCompletion = ensureCompletionState(source);
    // Prefer the caller-supplied task (the text actually dispatched to the
    // child session during steer/wake/orphan-resume) over the previous run's
    // stale `task`. Falling back to the prior task preserves behavior for any
    // caller that does not pass a replacement message. The orphan-session
    // recovery flow (`recoverOrphanedSubagentSessions` ->
    // `resumeOrphanedSession` / `buildResumeMessage` in
    // `subagent-orphan-recovery.ts`) rewraps the persisted `task` into the
    // `[Subagent Task]` block after a gateway restart; using stale text would
    // silently re-run the original instruction and lose the user's steer
    // update.
    const nextTask =
      typeof replaceParams.task === "string" && replaceParams.task.length > 0
        ? replaceParams.task
        : source.task;
    const next: SubagentRunRecord = normalizeSubagentRunState({
      ...source,
      runId: nextRunId,
      // New rows carry an exact owner. Legacy replacement rows must retain an
      // unknown owner so their bounded session fallback can still find the
      // original detached task across another restart.
      taskRunId: source.taskRunId,
      task: nextTask,
      generation,
      createdAt: now,
      startedAt: now,
      sessionStartedAt,
      accumulatedRuntimeMs,
      endedAt: undefined,
      endedReason: undefined,
      pauseReason: undefined,
      endedHookEmittedAt: undefined,
      browserCleanupDispatchedAt: undefined,
      deleteCleanupDispatchedAt: undefined,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: undefined,
      outcome: undefined,
      execution: {
        status: "running",
        startedAt: now,
        transcriptTarget: replaceParams.transcriptTarget,
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
      suppressCompletionDelivery: undefined,
      delivery: {
        status: source.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      spawnMode,
      archiveAtMs,
      runTimeoutSeconds,
    });
    clearDeliveryState(next);

    if (previousRunId !== nextRunId) {
      params.runs.delete(previousRunId);
    }
    params.runs.set(nextRunId, next);
    markOlderKillReconciliationsSuperseded(next);
    try {
      params.persistOrThrow();
    } catch (error) {
      // The gateway has already started nextRunId. Keep its in-memory owner
      // authoritative and retry best-effort persistence; rolling back here
      // would orphan a live run that can still mutate the shared session.
      log.warn("failed to persist replacement subagent run; retaining live successor", {
        error,
        previousRunId,
        nextRunId,
      });
      params.persist();
    }
    if (previousRunId !== nextRunId) {
      params.clearPendingLifecycleError(previousRunId);
      params.resumedRuns.delete(previousRunId);
      if (shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      if (
        source.execution?.transcriptTarget &&
        source.execution.transcriptTarget !== replaceParams.transcriptTarget
      ) {
        void removeInternalSessionEffectsSession(source.execution.transcriptTarget);
      }
    }
    params.ensureListener();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    void waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
    return true;
  };

  const registerSubagentRun = (registerParams: RegisterSubagentRunParams) => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const requesterTurnRunId = registerParams.requesterTurnRunId?.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const now = Date.now();
    const generation = nextSubagentRunGeneration(params.runs.values(), childSessionKey);
    const cfg = params.getRuntimeConfig();
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const archiveAtMs = resolveSubagentArchiveAtMs({
      cfg,
      now,
      spawnMode,
      cleanup: registerParams.cleanup,
      collect: registerParams.collect,
    });
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const queued = registerParams.queued === true;
    const entry: SubagentRunRecord = normalizeSubagentRunState({
      runId,
      taskRunId: runId,
      ...(requesterTurnRunId && registerParams.expectsCompletionMessage === true
        ? { requesterTurnRunId }
        : {}),
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterOrigin,
      progressOrigin: registerParams.progressOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      requesterAgentId: registerParams.requesterAgentId,
      task: registerParams.task,
      taskName: registerParams.taskName,
      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
      spawnMode,
      label: registerParams.label,
      model: registerParams.model,
      agentDir: registerParams.agentDir,
      workspaceDir: registerParams.workspaceDir,
      runTimeoutSeconds,
      collect: registerParams.collect,
      swarmRequesterSessionKey: registerParams.swarmRequesterSessionKey,
      swarmWaitOwnerSessionKeys:
        registerParams.collect && registerParams.swarmRequesterSessionKey
          ? resolveSwarmWaitOwnerSessionKeys(params.runs, registerParams.swarmRequesterSessionKey)
          : undefined,
      swarmRunId: registerParams.collect ? runId : undefined,
      schedulerSlotId: registerParams.collect ? runId : undefined,
      swarmLaunchIdempotencyKey: registerParams.swarmLaunchIdempotencyKey,
      swarmLaunchReplayKey: registerParams.swarmLaunchReplayKey,
      swarmLaunchRequestFingerprint: registerParams.swarmLaunchRequestFingerprint,
      swarmLaunchPending: registerParams.collect === true,
      groupId: registerParams.groupId,
      outputSchema: registerParams.outputSchema,
      queuedLaunch: registerParams.queuedLaunch,
      generation,
      createdAt: now,
      startedAt: queued ? undefined : now,
      execution: {
        status: queued ? "queued" : "running",
        startedAt: queued ? undefined : now,
      },
      completion: {
        required: registerParams.expectsCompletionMessage === true,
      },
      delivery: {
        status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      sessionStartedAt: queued ? undefined : now,
      accumulatedRuntimeMs: 0,
      archiveAtMs,
      cleanupHandled: false,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    });
    params.runs.set(runId, entry);
    const killReconciliationSnapshots = markOlderKillReconciliationsSuperseded(entry);
    try {
      params.persistOrThrow();
    } catch (error) {
      params.runs.delete(runId);
      restoreKillReconciliationSnapshots(killReconciliationSnapshots);
      throw error;
    }
    try {
      const taskParams = {
        runtime: "subagent",
        sourceId: runId,
        ownerKey: requesterSessionKey,
        scopeKind: "session",
        requesterOrigin,
        childSessionKey,
        runId,
        label: registerParams.label,
        task: registerParams.task,
        agentId: registerParams.agentId,
        requesterAgentId: registerParams.requesterAgentId,
        deliveryStatus:
          registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
      } as const;
      const task = queued
        ? createQueuedTaskRun(taskParams)
        : createRunningTaskRun({
            ...taskParams,
            startedAt: now,
            lastEventAt: now,
          });
      if (!task) {
        log.warn("Failed to persist background task for subagent run", {
          runId: registerParams.runId,
        });
      }
    } catch (error) {
      log.warn("Failed to create background task for subagent run", {
        runId: registerParams.runId,
        error,
      });
    }
    params.ensureListener();
    params.persist();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    // Wait for subagent completion via gateway RPC (cross-process).
    // The in-process lifecycle listener is a fallback for embedded runs.
    if (!queued) {
      void waitForSubagentCompletion(runId, waitTimeoutMs, entry);
    }
  };

  const startQueuedSubagentRun = (runId: string, gatewayRunId?: string) => {
    const key = runId.trim();
    const entry =
      params.runs.get(key) ??
      [...params.runs.values()].find((candidate) => candidate.swarmRunId === key);
    const lifecycleStarted =
      entry?.execution?.status === "running" &&
      typeof entry.execution.startedAt === "number" &&
      entry.swarmLaunchPending === true;
    const provisionalTerminalBeforeAcceptance =
      entry?.swarmLaunchPending === true &&
      typeof entry.endedAt === "number" &&
      entry.collectorCompletion === undefined;
    if (provisionalTerminalBeforeAcceptance) {
      // Cancellation won before Gateway acceptance. The caller must abort the
      // newly accepted run before freezing completion or releasing the FIFO slot.
      return false;
    }
    // Completion clears swarmLaunchPending, but queuedLaunch remains until the
    // delayed acceptance response remaps the durable terminal row.
    const terminalBeforeAcceptance =
      entry?.collectorCompletion !== undefined && entry.queuedLaunch !== undefined;
    if (
      !entry ||
      (!terminalBeforeAcceptance && entry.execution?.status !== "queued" && !lifecycleStarted)
    ) {
      return false;
    }
    const nextRunId = gatewayRunId?.trim() || entry.runId;
    const conflicting = params.runs.get(nextRunId);
    if (conflicting && conflicting !== entry) {
      throw new Error(`collector gateway run id already exists: ${nextRunId}`);
    }
    const acceptedAt = Date.now();
    const previousRunId = entry.runId;
    const previousStartedAt = entry.startedAt;
    const previousSessionStartedAt = entry.sessionStartedAt;
    const previousExecution = entry.execution;
    const previousQueuedLaunch = entry.queuedLaunch;
    const previousSwarmRunId = entry.swarmRunId;
    const previousSchedulerSlotId = entry.schedulerSlotId;
    const previousSwarmLaunchPending = entry.swarmLaunchPending;
    entry.swarmRunId ??= previousRunId;
    entry.schedulerSlotId ??= entry.swarmRunId;
    if (previousRunId !== nextRunId) {
      params.runs.delete(previousRunId);
      entry.runId = nextRunId;
      params.runs.set(nextRunId, entry);
    }
    if (terminalBeforeAcceptance) {
      entry.swarmLaunchPending = false;
      entry.queuedLaunch = undefined;
      try {
        params.persistOrThrow();
        return true;
      } catch (error) {
        if (previousRunId !== nextRunId) {
          params.runs.delete(nextRunId);
          entry.runId = previousRunId;
          params.runs.set(previousRunId, entry);
        }
        entry.queuedLaunch = previousQueuedLaunch;
        entry.swarmRunId = previousSwarmRunId;
        entry.schedulerSlotId = previousSchedulerSlotId;
        entry.swarmLaunchPending = previousSwarmLaunchPending;
        throw error;
      }
    }
    // Gateway acceptance only proves admission. Preserve a lifecycle start that
    // raced ahead of this response; otherwise leave the run clock unset until
    // preparation and lane dequeue emit the canonical start event.
    const lifecycleStartedAt =
      entry.execution?.status === "running" ? entry.execution.startedAt : undefined;
    if (typeof lifecycleStartedAt === "number") {
      entry.startedAt = lifecycleStartedAt;
      entry.sessionStartedAt ??= lifecycleStartedAt;
      entry.execution = {
        ...entry.execution,
        status: "running",
        acceptedAt,
        startedAt: lifecycleStartedAt,
      };
    } else {
      delete entry.startedAt;
      delete entry.sessionStartedAt;
      entry.execution = { ...entry.execution, status: "running", acceptedAt };
      delete entry.execution.startedAt;
    }
    entry.swarmLaunchPending = false;
    entry.queuedLaunch = undefined;
    let persistedRunning = false;
    try {
      params.persistOrThrow();
      persistedRunning = true;
      startTaskRunByRunId({
        runId: entry.taskRunId ?? entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        startedAt: acceptedAt,
        lastEventAt: acceptedAt,
      });
    } catch (error) {
      if (previousRunId !== nextRunId) {
        params.runs.delete(nextRunId);
        entry.runId = previousRunId;
        params.runs.set(previousRunId, entry);
      }
      entry.startedAt = previousStartedAt;
      entry.sessionStartedAt = previousSessionStartedAt;
      entry.execution = previousExecution;
      entry.queuedLaunch = previousQueuedLaunch;
      entry.swarmRunId = previousSwarmRunId;
      entry.schedulerSlotId = previousSchedulerSlotId;
      entry.swarmLaunchPending = previousSwarmLaunchPending;
      if (persistedRunning) {
        try {
          params.persistOrThrow();
        } catch (rollbackError) {
          // The failure callback terminalizes this in-memory queued row next.
          log.warn("failed to persist collector start rollback", {
            runId: previousRunId,
            error: rollbackError,
          });
        }
      }
      throw error;
    }
    const cfg = params.getRuntimeConfig();
    void waitForSubagentCompletion(
      nextRunId,
      params.resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds),
      entry,
    );
    return true;
  };

  const failQueuedSubagentRun = (runId: string, error: string) => {
    const key = runId.trim();
    const entry =
      params.runs.get(key) ??
      [...params.runs.values()].find((candidate) => candidate.swarmRunId === key);
    if (!entry || entry.execution?.status !== "queued") {
      return false;
    }
    const snapshot = structuredClone(entry);
    const endedAt = Date.now();
    entry.endedAt = endedAt;
    entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    entry.outcome = { status: "error", error, endedAt };
    entry.execution = { ...entry.execution, status: "terminal", endedAt, outcome: entry.outcome };
    entry.queuedLaunch = undefined;
    entry.collectorLaunchCleanupPending = true;
    entry.completion = { required: false, resultText: error, capturedAt: endedAt };
    updateSwarmCollectorCompletion(entry, params.getRuntimeConfig());
    try {
      params.persistOrThrow();
    } catch (persistError) {
      const target = entry as unknown as Record<string, unknown>;
      for (const property of Object.keys(target)) {
        delete target[property];
      }
      Object.assign(target, snapshot);
      throw persistError;
    }
    try {
      finalizeTaskRunByRunId({
        runId: entry.taskRunId ?? entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        status: "failed",
        endedAt,
        lastEventAt: endedAt,
        error,
        suppressDelivery: true,
      });
    } catch (taskError) {
      // Collector failure is already durable. Detached-task cleanup cannot
      // turn it back into queued work or the scheduler could launch it twice.
      log.warn("failed to finalize task after collector launch failure", {
        runId: entry.runId,
        error: taskError,
      });
    }
    return true;
  };

  const settleFailedQueuedSubagentLaunch = (runId: string, error: string) => {
    const entry =
      params.runs.get(runId) ??
      [...params.runs.values()].find((candidate) => candidate.swarmRunId === runId);
    if (!entry?.collect) {
      return false;
    }
    if (typeof entry.endedAt !== "number") {
      return failQueuedSubagentRun(runId, error);
    }
    if (entry.collectorCompletion) {
      return true;
    }
    const snapshot = structuredClone(entry);
    entry.swarmLaunchPending = false;
    entry.collectorLaunchCleanupPending = true;
    entry.queuedLaunch = undefined;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: entry.endedAt,
      outcome: entry.outcome,
    };
    entry.completion = {
      required: false,
      resultText: entry.outcome?.status === "error" ? (entry.outcome.error ?? error) : error,
      capturedAt: entry.endedAt,
    };
    updateSwarmCollectorCompletion(entry, params.getRuntimeConfig());
    try {
      params.persistOrThrow();
    } catch (persistError) {
      const target = entry as unknown as Record<string, unknown>;
      for (const property of Object.keys(target)) {
        delete target[property];
      }
      Object.assign(target, snapshot);
      throw persistError;
    }
    return true;
  };

  const releaseSubagentRun = (runId: string) => {
    params.clearPendingLifecycleError(runId);
    const entry = params.runs.get(runId);
    if (entry) {
      if (shouldDeleteAttachments(entry)) {
        void safeRemoveAttachmentsDir(entry);
      }
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: entry.childSessionKey,
        reason: "released",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      });
    }
    const didDelete = params.runs.delete(runId);
    if (didDelete) {
      params.persist();
    }
    if (params.runs.size === 0) {
      params.stopSweeper();
    }
  };

  const markSubagentRunTerminated = (markParams: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
    suppressTaskDelivery?: boolean;
  }): number => {
    const runIds = new Set<string>();
    if (typeof markParams.runId === "string" && markParams.runId.trim()) {
      runIds.add(markParams.runId.trim());
    }
    if (typeof markParams.childSessionKey === "string" && markParams.childSessionKey.trim()) {
      for (const [runId, entry] of params.runs.entries()) {
        if (entry.childSessionKey === markParams.childSessionKey.trim()) {
          runIds.add(runId);
        }
      }
    }
    if (runIds.size === 0) {
      return 0;
    }

    const now = Date.now();
    const reason = markParams.reason?.trim() || "killed";
    let updated = 0;
    const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
    const queuedCollectorRunIds: string[] = [];
    const entrySnapshots = new Map<SubagentRunRecord, SubagentRunRecord>();
    const pendingTaskFinalizations: Array<{ entry: SubagentRunRecord; endedAt: number }> = [];
    const finalizeKilledTask = (entry: SubagentRunRecord, endedAt: number) => {
      const taskResolution = params.resolveSubagentTask(entry);
      const task = taskResolution.lookup === "available" ? taskResolution.task : undefined;
      const targetRunId = task?.runId ?? entry.taskRunId ?? entry.runId;
      const targetSessionKey = task?.childSessionKey ?? entry.childSessionKey;
      try {
        finalizeTaskRunByRunId({
          runId: targetRunId,
          runtime: "subagent",
          sessionKey: targetSessionKey,
          status: "cancelled",
          endedAt,
          lastEventAt: endedAt,
          error: SUBAGENT_KILL_TASK_ERROR,
          suppressDelivery: entry.killReconciliation?.suppressTaskDelivery === true,
        });
      } catch (err) {
        log.warn("failed to finalize killed subagent task run", {
          err,
          runId: targetRunId,
          childSessionKey: targetSessionKey,
        });
      }
    };
    for (const runId of runIds) {
      params.clearPendingLifecycleError(runId);
      params.clearPendingLifecycleTimeout(runId);
      const entry = params.runs.get(runId);
      if (!entry) {
        continue;
      }
      const wasKilledLifecycle =
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.killReconciliation !== undefined;
      const existingKillReconciliation = entry.killReconciliation;
      if (
        typeof entry.endedAt === "number" &&
        entry.pauseReason !== "sessions_yield" &&
        !wasKilledLifecycle
      ) {
        // An abort lifecycle event can mark the run killed before this shared
        // termination path runs. Re-enter only for that provisional state so
        // it receives the same reconciliation tombstone as a direct kill.
        continue;
      }
      entrySnapshots.set(entry, structuredClone(entry));
      const wasYielded = entry.pauseReason === "sessions_yield";
      const wasQueuedCollector = entry.collect && entry.execution?.status === "queued";
      const collectorLaunchInFlight =
        wasQueuedCollector &&
        entry.swarmLaunchPending === true &&
        !isSwarmRunQueued(entry.schedulerSlotId ?? entry.runId);
      if (wasQueuedCollector) {
        queuedCollectorRunIds.push(entry.runId);
      }
      const endedAt =
        (wasYielded || wasKilledLifecycle) && typeof entry.endedAt === "number"
          ? entry.endedAt
          : now;
      entry.endedAt = endedAt;
      entry.outcome = withSubagentOutcomeTiming(
        { status: "error", error: reason },
        {
          startedAt: entry.startedAt,
          endedAt,
        },
      );
      entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
      entry.cleanupHandled = true;
      entry.cleanupCompletedAt = existingKillReconciliation
        ? (entry.cleanupCompletedAt ?? endedAt)
        : wasKilledLifecycle
          ? endedAt
          : now;
      entry.suppressAnnounceReason = "killed";
      entry.pauseReason = undefined;
      // Setting endedAt above short-circuits the completion watcher, so the
      // lifecycle finalizer never reaches the detached task row for killed runs.
      const taskEndedAt = existingKillReconciliation
        ? (resolveKilledSubagentTaskEndedAt(entry) ?? endedAt)
        : wasYielded
          ? now
          : endedAt;
      entry.killReconciliation = {
        killedAt: existingKillReconciliation?.killedAt ?? taskEndedAt,
        suppressTaskDelivery:
          existingKillReconciliation?.suppressTaskDelivery === true ||
          markParams.suppressTaskDelivery === true
            ? true
            : undefined,
        supersededAt: existingKillReconciliation?.supersededAt,
      };
      if (wasQueuedCollector && !collectorLaunchInFlight) {
        updateSwarmCollectorCompletion(entry, params.getRuntimeConfig());
      }
      pendingTaskFinalizations.push({ entry, endedAt: taskEndedAt });
      if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
        entriesByChildSessionKey.set(entry.childSessionKey, entry);
      }
      updated += 1;
    }
    if (updated > 0) {
      try {
        // The registry tombstone is the recovery source for the provisional
        // task marker. It must commit first so the sweeper can always finish it.
        params.persistOrThrow();
      } catch (error) {
        for (const [entry, snapshot] of entrySnapshots) {
          const target = entry as unknown as Record<string, unknown>;
          for (const key of Object.keys(target)) {
            delete target[key];
          }
          Object.assign(target, snapshot);
        }
        throw error;
      }
      for (const pending of pendingTaskFinalizations) {
        finalizeKilledTask(pending.entry, pending.endedAt);
      }
      for (const runId of queuedCollectorRunIds) {
        const entry = params.runs.get(runId);
        removeQueuedSwarmRun(entry?.schedulerSlotId ?? runId);
      }
      for (const entry of entriesByChildSessionKey.values()) {
        // Task finalization removes the suspension blocker before these session-owned
        // writes finish. Join them under one independent root so snapshots stay atomic.
        void runWithGatewayIndependentRootWorkAdmission(async () => {
          await Promise.all([
            persistSubagentSessionTiming(entry, {
              isCurrentGeneration: () => currentRunOwnsSession(entry),
            }).catch((err: unknown) => {
              log.warn("failed to persist killed subagent session timing", {
                err,
                runId: entry.runId,
                childSessionKey: entry.childSessionKey,
              });
            }),
            shouldDeleteAttachments(entry) ? safeRemoveAttachmentsDir(entry) : Promise.resolve(),
          ]);
        }).catch((err: unknown) => {
          log.warn("failed to run killed subagent cleanup tail", {
            err,
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          });
        });
        params.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          // A direct kill is provisional until the runner reports its final
          // outcome. Keep delete-mode rows as reconciliation tombstones.
          cleanup: "keep",
          completedAt: now,
          preserveTranscript: true,
          provisionalKill: true,
        });
      }
    }
    return updated;
  };

  return {
    clearSubagentRunSteerRestart,
    markSubagentRunForSteerRestart,
    markSubagentRunTerminated,
    registerSubagentRun,
    startQueuedSubagentRun,
    failQueuedSubagentRun,
    settleFailedQueuedSubagentLaunch,
    releaseSubagentRun,
    replaceSubagentRunAfterSteer,
    waitForSubagentCompletion,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
