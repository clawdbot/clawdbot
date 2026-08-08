/**
 * Subagent run manager.
 *
 * Waits for child runs, records terminal outcomes, creates task-runtime entries, and archives completed sessions.
 */
import { getRuntimeConfig } from "../config/config.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../infra/agent-events.js";
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
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
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
  SubagentCompletionRequest,
  SubagentProgressOrigin,
  SubagentRestartRecoveryReceipt,
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

function restoreSubagentRunRecord(entry: SubagentRunRecord, snapshot: SubagentRunRecord): void {
  const target = entry as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, snapshot);
}

function resolveSwarmWaitOwnerSessionKeys(
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>,
  requesterSessionKey: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited = new Set<string>();
  let currentSessionKey = requesterSessionKey.trim();
  while (currentSessionKey && !visited.has(currentSessionKey)) {
    visited.add(currentSessionKey);
    ownerSessionKeys.push(currentSessionKey);
    let latestOwner: SubagentRunRecord | undefined;
    for (const candidate of getRunsForChildSession(currentSessionKey)) {
      if (!latestOwner || compareSubagentRunGeneration(candidate, latestOwner) > 0) {
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
    shouldSuppressSubagentRecoverySessionEffects(entry) ||
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
    entry.suppressAnnounceReason === "killed" ||
    (entry.cleanup === "delete" && Number.isFinite(entry.deleteCleanupDispatchedAt))
  ) {
    // agent.wait and lifecycle events can report an old yield after terminal
    // ownership settles. Reviving the row would expose a run whose session may
    // belong to a newer lifecycle or already be gone.
    return false;
  }
  let mutated = false;
  if (typeof params.startedAt === "number" && entry.execution.startedAt !== params.startedAt) {
    entry.execution = { ...entry.execution, startedAt: params.startedAt };
    if (typeof entry.sessionStartedAt !== "number") {
      entry.sessionStartedAt = params.startedAt;
    }
    mutated = true;
  }
  const endedAt = typeof params.endedAt === "number" ? params.endedAt : (params.now ?? Date.now());
  if (
    entry.execution.status !== "terminal" ||
    entry.execution.endedAt !== endedAt ||
    entry.execution.outcome !== undefined
  ) {
    entry.execution = { ...entry.execution, status: "terminal", endedAt };
    delete entry.execution.outcome;
    mutated = true;
  }
  if (entry.pauseReason !== "sessions_yield") {
    entry.pauseReason = "sessions_yield";
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
    completion.terminalReply = undefined;
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
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist(...runIds: string[]): void;
  persistOrThrow(...runIds: string[]): void;
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
  clearPendingLifecycleTimeout(runId: string): void;
  resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number): number;
  scheduleSweep(args?: { delayMs?: number }): void;
  resolveSubagentSessionCompletion(args: {
    childSessionKey: string;
    fallbackEndedAt: number;
    notBeforeMs?: number;
  }): SubagentSessionCompletion | null;
  resolveSubagentSessionStartedAt(args: {
    childSessionKey: string;
    notBeforeMs?: number;
  }): number | undefined;
  notifyContextEngineSubagentEnded(
    args: {
      childSessionKey: string;
      reason: "completed" | "deleted" | "released";
      agentDir?: string;
      workspaceDir?: string;
    },
    options?: { isCurrent?: () => boolean },
  ): Promise<void>;
  completeCleanupBookkeeping(args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
    preserveTranscript?: boolean;
    provisionalKill?: boolean;
  }): void;
  completeSubagentRun(args: SubagentCompletionRequest): Promise<void>;
  resolveSubagentTask(entry: SubagentRunRecord): DetachedTaskFindResult;
}) {
  const findRunByIdentity = (runId: string): SubagentRunRecord | undefined =>
    params.runs.get(runId) ??
    [...params.runs.values()].find((candidate) => candidate.swarmRunId === runId);

  const markOlderKillReconciliationsSuperseded = (next: SubagentRunRecord) => {
    const snapshots = new Map<SubagentRunRecord, SubagentRunRecord["killReconciliation"]>();
    for (const candidate of params.getRunsForChildSession(next.childSessionKey)) {
      if (
        candidate.runId === next.runId ||
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
    !Array.from(params.getRunsForChildSession(entry.childSessionKey)).some(
      (candidate) => compareSubagentRunGeneration(candidate, entry) > 0,
    );

  const restoreKillReconciliationSnapshots = (
    snapshots: Map<SubagentRunRecord, SubagentRunRecord["killReconciliation"]>,
  ) => {
    for (const [entry, snapshot] of snapshots) {
      entry.killReconciliation = snapshot;
    }
  };

  const runSubagentCompletionWait = async (
    runId: string,
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
    capWaitToStoredDeadline = false,
  ): Promise<void> => {
    let completionForRetry: Parameters<typeof params.completeSubagentRun>[0] | undefined;
    const scheduleWaitRetry = (entry: SubagentRunRecord, reason: string, error?: string) => {
      params.scheduleSweep({ delayMs: 1_000 });
      const scheduledEntry = entry;
      setTimeout(() => {
        const current = params.runs.get(runId);
        if (
          !current ||
          current !== scheduledEntry ||
          typeof current.execution.endedAt === "number"
        ) {
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
          params.persist(entry.runId);
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
              notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
            });
      const completeAsRunTimeout = async (endedAt?: number, startedAt?: number) => {
        const timeoutCompletion: Parameters<typeof params.completeSubagentRun>[0] = {
          runId,
          outcome: { status: "timeout" },
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          terminalReply: wait.terminalReply,
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
          notBeforeMs: observedStartedAt ?? entry.execution.startedAt ?? entry.createdAt,
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
        if (observedStartedAt !== undefined && entry.execution.startedAt !== observedStartedAt) {
          entry.execution = { ...entry.execution, startedAt: observedStartedAt };
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = observedStartedAt;
          }
          params.persist(entry.runId);
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
        startedAt: observedStartedAt ?? entry.execution.startedAt,
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
        terminalReply: wait.terminalReply,
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
        typeof current.execution.endedAt === "number" &&
        !current.cleanupCompletedAt &&
        current.pauseReason !== "sessions_yield"
      ) {
        current.cleanupHandled = false;
        params.resumedRuns.delete(runId);
        params.resumeSubagentRun(runId);
      } else if (completionForRetry && typeof current.execution.endedAt !== "number") {
        params.scheduleSweep({ delayMs: 1_000 });
      }
    }
  };

  // Child completion outlives the spawning attempt, so all launch and retry
  // paths must start without inheriting its soon-to-be-disposed writer.
  const waitForSubagentCompletion: typeof runSubagentCompletionWait = (...args) =>
    runWithoutOwnedSessionTranscriptWrites(() => runSubagentCompletionWait(...args));

  const markSubagentRunForSteerRestart = (runId: string, expected?: SubagentRunRecord) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (
      !entry ||
      (expected && entry !== expected) ||
      entry.execution.restartRecovery ||
      entry.killIntent ||
      entry.killReconciliation
    ) {
      return false;
    }
    if (entry.suppressAnnounceReason === "steer-restart") {
      return false;
    }
    entry.suppressAnnounceReason = "steer-restart";
    try {
      params.persistOrThrow(entry.runId);
    } catch (error) {
      entry.suppressAnnounceReason = undefined;
      throw error;
    }
    return true;
  };

  const clearSubagentRunSteerRestart = (runId: string, expected?: SubagentRunRecord) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry || (expected && entry !== expected)) {
      return false;
    }
    if (entry.suppressAnnounceReason !== "steer-restart") {
      return true;
    }
    if (typeof entry.execution.endedAt === "number") {
      const taskResolution = params.resolveSubagentTask(entry);
      const task = taskResolution.lookup === "available" ? taskResolution.task : undefined;
      const terminal =
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED
          ? {
              status: "cancelled" as const,
              endedAt: entry.execution.endedAt,
              lastEventAt: entry.execution.endedAt,
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
    params.persist(entry.runId);
    // If the interrupted run already finished while suppression was active, retry
    // cleanup now so completion output is not lost when restart dispatch fails.
    params.resumedRuns.delete(key);
    if (typeof entry.execution.endedAt === "number" && !entry.cleanupCompletedAt) {
      params.resumeSubagentRun(key);
    }
    return true;
  };

  const replaceSubagentRunAfterSteer = (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    expected?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    allowEndedSource?: boolean;
    preserveFrozenResultFallback?: boolean;
    transcriptTarget?: AgentRunSessionTarget;
    task?: string;
    restartRecovery?: SubagentRestartRecoveryReceipt;
    lifecycleGeneration?: string;
    requirePersistence?: boolean;
  }) => {
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

    const previous = params.runs.get(previousRunId);
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

    const now = Date.now();
    const generation = nextSubagentRunGeneration(
      [...params.getRunsForChildSession(source.childSessionKey), source],
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
      sessionStartedAt,
      accumulatedRuntimeMs,
      endedReason: undefined,
      pauseReason: undefined,
      endedHookEmittedAt: undefined,
      browserCleanupDispatchedAt: undefined,
      deleteCleanupDispatchedAt: undefined,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: undefined,
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
      archiveAtMs,
      runTimeoutSeconds,
    });
    clearDeliveryState(next);

    if (previousRunId !== nextRunId) {
      params.runs.delete(previousRunId);
    }
    params.runs.set(nextRunId, next);
    const killReconciliationSnapshots = markOlderKillReconciliationsSuperseded(next);
    const changedRunIds = [
      previousRunId,
      nextRunId,
      ...[...killReconciliationSnapshots.keys()].map((entry) => entry.runId),
    ];
    try {
      params.persistOrThrow(...changedRunIds);
    } catch (error) {
      if (
        replaceParams.requirePersistence === true ||
        replaceParams.lifecycleGeneration !== undefined
      ) {
        restoreKillReconciliationSnapshots(killReconciliationSnapshots);
        params.runs.delete(nextRunId);
        params.runs.set(previousRunId, source);
        log.warn("failed to persist replacement subagent recovery run; restored source lease", {
          error,
          previousRunId,
          nextRunId,
        });
        return false;
      }
      // The gateway has already started nextRunId. Keep its in-memory owner
      // authoritative and retry best-effort persistence; rolling back here
      // would orphan a live run that can still mutate the shared session.
      log.warn("failed to persist replacement subagent run; retaining live successor", {
        error,
        previousRunId,
        nextRunId,
      });
      params.persist(...changedRunIds);
    }
    if (previousRunId !== nextRunId) {
      params.clearPendingLifecycleError(previousRunId);
      params.resumedRuns.delete(previousRunId);
      if (shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      if (
        source.execution.transcriptTarget &&
        source.execution.transcriptTarget !== replaceParams.transcriptTarget
      ) {
        void removeInternalSessionEffectsSession(source.execution.transcriptTarget);
      }
    }
    params.ensureListener();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    if (!next.execution.restartRecovery) {
      void waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
    }
    return true;
  };

  const reserveSubagentRestartRecoveryLaunch = (reserveParams: {
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
    const entry = params.runs.get(runId);
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
      params.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = previousLease;
      entry.swarmLaunchIdempotencyKey = previousCollectorLaunch.idempotencyKey;
      entry.swarmLaunchPending = previousCollectorLaunch.pending;
      throw error;
    }
    return idempotencyKey;
  };

  const markSubagentRestartRecoveryLaunchAttempted = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
    lifecycleGeneration: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = params.runs.get(runId);
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
      params.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return attempted;
  };

  const abandonSubagentRestartRecoveryLaunch = (abandonParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = abandonParams.runId.trim();
    const entry = params.runs.get(runId);
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
      params.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return true;
  };

  const markSubagentRestartRecoveryLaunchConsumed = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = params.runs.get(runId);
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
    params.persistOrThrow(runId);
    return consumed;
  };

  const markSubagentRestartRecoveryLaunchAccepted = (markParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): SubagentRestartRecoveryReceipt | undefined => {
    const runId = markParams.runId.trim();
    const entry = params.runs.get(runId);
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
    const accepted = { ...receipt, phase: "accepted" as const };
    entry.execution.restartRecovery = accepted;
    try {
      params.persistOrThrow(runId);
    } catch (error) {
      // Gateway acceptance is irreversible. Keep the in-memory fact and let the
      // caller immediately attempt the strict successor remap.
      log.warn("failed to persist accepted subagent restart recovery receipt", {
        error,
        runId,
      });
    }
    return accepted;
  };

  const clearAcceptedSubagentRestartRecovery = (clearParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = clearParams.runId.trim();
    const entry = params.runs.get(runId);
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
    entry.execution.restartRecovery = undefined;
    try {
      params.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
    return true;
  };

  const resumeSettledSubagentRestartRecovery = (resumeParams: {
    runId: string;
    expected: SubagentRunRecord;
  }): boolean => {
    const runId = resumeParams.runId.trim();
    const entry = params.runs.get(runId);
    if (
      !runId ||
      entry !== resumeParams.expected ||
      entry.execution.restartRecovery !== undefined
    ) {
      return false;
    }
    if (entry.killIntent || entry.killReconciliation) {
      return true;
    }
    params.resumeSubagentRun(runId);
    return true;
  };

  const resetSubagentRestartRecoveryLaunchAttempt = (resetParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionMarker: string;
    idempotencyKey: string;
  }): boolean => {
    const runId = resetParams.runId.trim();
    const entry = params.runs.get(runId);
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
      params.persistOrThrow(runId);
    } catch (error) {
      entry.execution.restartRecovery = receipt;
      throw error;
    }
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
    const generation = nextSubagentRunGeneration(
      params.getRunsForChildSession(childSessionKey),
      childSessionKey,
    );
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
          ? resolveSwarmWaitOwnerSessionKeys(
              params.getRunsForChildSession,
              registerParams.swarmRequesterSessionKey,
            )
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
      execution: {
        status: queued ? "queued" : "running",
        startedAt: queued ? undefined : now,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
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
      params.persistOrThrow(
        runId,
        ...[...killReconciliationSnapshots.keys()].map((candidate) => candidate.runId),
      );
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
        // Detached task runtimes are plugin-replaceable. Isolate their input so
        // mutation cannot change the already-persisted registry record.
        requesterOrigin: requesterOrigin ? structuredClone(requesterOrigin) : undefined,
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
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    // Wait for subagent completion via gateway RPC (cross-process).
    // The in-process lifecycle listener is a fallback for embedded runs.
    if (!queued) {
      void waitForSubagentCompletion(runId, waitTimeoutMs, entry);
    }
  };

  const startQueuedSubagentRun = (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
  ) => {
    const key = runId.trim();
    const entry = findRunByIdentity(key);
    const acceptedLifecycleGeneration = lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    if (
      lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      return false;
    }
    const lifecycleStarted =
      entry?.execution.status === "running" &&
      typeof entry.execution.startedAt === "number" &&
      entry.swarmLaunchPending === true;
    const provisionalTerminalBeforeAcceptance =
      entry?.swarmLaunchPending === true &&
      typeof entry.execution.endedAt === "number" &&
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
      entry.killIntent ||
      entry.killReconciliation ||
      (!terminalBeforeAcceptance && entry.execution.status !== "queued" && !lifecycleStarted)
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
    const previous = structuredClone(entry);
    const restoreQueuedRun = () => {
      if (previousRunId !== nextRunId) {
        params.runs.delete(nextRunId);
      }
      restoreSubagentRunRecord(entry, previous);
      if (previousRunId !== nextRunId) {
        params.runs.set(previousRunId, entry);
      }
    };
    entry.swarmRunId ??= previousRunId;
    entry.schedulerSlotId ??= entry.swarmRunId;
    if (previousRunId !== nextRunId) {
      params.runs.delete(previousRunId);
      entry.runId = nextRunId;
      params.runs.set(nextRunId, entry);
    }
    if (!terminalBeforeAcceptance) {
      // Acceptance is not a lifecycle start; preserve a raced start or leave its clock unset.
      const lifecycleStartedAt =
        entry.execution.status === "running" ? entry.execution.startedAt : undefined;
      if (typeof lifecycleStartedAt === "number") {
        entry.sessionStartedAt ??= lifecycleStartedAt;
        entry.execution = {
          ...entry.execution,
          status: "running",
          acceptedAt,
          lifecycleGeneration: acceptedLifecycleGeneration,
          restartRecovery: undefined,
          suppressSessionEffects: undefined,
          startedAt: lifecycleStartedAt,
        };
      } else {
        delete entry.sessionStartedAt;
        entry.execution = {
          ...entry.execution,
          status: "running",
          acceptedAt,
          lifecycleGeneration: acceptedLifecycleGeneration,
          restartRecovery: undefined,
          suppressSessionEffects: undefined,
        };
        delete entry.execution.startedAt;
      }
    }
    entry.swarmLaunchPending = false;
    entry.queuedLaunch = undefined;
    let persistedRunning = false;
    try {
      params.persistOrThrow(previousRunId, nextRunId);
      if (terminalBeforeAcceptance) {
        return true;
      }
      persistedRunning = true;
      startTaskRunByRunId({
        runId: entry.taskRunId ?? entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        startedAt: acceptedAt,
        lastEventAt: acceptedAt,
      });
    } catch (error) {
      restoreQueuedRun();
      if (persistedRunning) {
        try {
          params.persistOrThrow(previousRunId, nextRunId);
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
    const entry = findRunByIdentity(key);
    if (!entry || entry.execution.status !== "queued") {
      return false;
    }
    const snapshot = structuredClone(entry);
    const endedAt = Date.now();
    entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "error", error, endedAt },
    };
    entry.queuedLaunch = undefined;
    entry.collectorLaunchCleanupPending = true;
    entry.completion = { required: false, resultText: error, capturedAt: endedAt };
    updateSwarmCollectorCompletion(entry, params.getRuntimeConfig());
    try {
      params.persistOrThrow(entry.runId);
    } catch (persistError) {
      restoreSubagentRunRecord(entry, snapshot);
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
    const entry = findRunByIdentity(runId);
    if (!entry?.collect) {
      return false;
    }
    if (typeof entry.execution.endedAt !== "number") {
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
      endedAt: entry.execution.endedAt,
    };
    entry.completion = {
      required: false,
      resultText:
        entry.execution.outcome?.status === "error"
          ? (entry.execution.outcome.error ?? error)
          : error,
      capturedAt: entry.execution.endedAt,
    };
    updateSwarmCollectorCompletion(entry, params.getRuntimeConfig());
    try {
      params.persistOrThrow(entry.runId);
    } catch (persistError) {
      restoreSubagentRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };

  const releaseSubagentRun = (runId: string) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    params.runs.delete(runId);
    try {
      params.persistOrThrow(runId);
    } catch (error) {
      params.runs.set(runId, entry);
      throw error;
    }
    params.clearPendingLifecycleError(runId);
    if (shouldDeleteAttachments(entry)) {
      void safeRemoveAttachmentsDir(entry);
    }
    const releasedSessionStillUnowned = () =>
      !Array.from(params.getRunsForChildSession(entry.childSessionKey)).some(
        (candidate) => candidate !== entry,
      );
    void params.notifyContextEngineSubagentEnded(
      {
        childSessionKey: entry.childSessionKey,
        reason: "released",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      },
      { isCurrent: releasedSessionStillUnowned },
    );
    if (params.runs.size === 0) {
      params.stopSweeper();
    }
  };

  const claimSubagentRunKill = (claimParams: {
    runId: string;
    expected: SubagentRunRecord;
    sessionId?: string;
    sessionLifecycleRevision?: string;
    suppressTaskDelivery?: boolean;
  }) => {
    const runId = claimParams.runId.trim();
    const entry = params.runs.get(runId);
    if (
      !runId ||
      entry !== claimParams.expected ||
      entry.killReconciliation !== undefined ||
      entry.killIntent !== undefined ||
      (typeof entry.execution.endedAt === "number" && entry.pauseReason !== "sessions_yield")
    ) {
      return undefined;
    }
    const claim = {
      requestedAt: Date.now(),
      reason: "killed",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionId: claimParams.sessionId?.trim() || undefined,
      sessionLifecycleRevision: claimParams.sessionLifecycleRevision?.trim() || undefined,
      suppressTaskDelivery: claimParams.suppressTaskDelivery === true ? true : undefined,
    };
    entry.killIntent = claim;
    try {
      params.persistOrThrow(runId);
    } catch (error) {
      entry.killIntent = undefined;
      throw error;
    }
    return claim;
  };

  const releaseSubagentRunKillClaim = (releaseParams: {
    runId: string;
    expected: SubagentRunRecord;
    claim: NonNullable<SubagentRunRecord["killIntent"]>;
  }): boolean => {
    const runId = releaseParams.runId.trim();
    const entry = params.runs.get(runId);
    if (!runId || entry !== releaseParams.expected || entry.killIntent !== releaseParams.claim) {
      return false;
    }
    entry.killIntent = undefined;
    try {
      params.persistOrThrow(runId);
    } catch (error) {
      entry.killIntent = releaseParams.claim;
      throw error;
    }
    return true;
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
    const childSessionKey = markParams.childSessionKey?.trim();
    if (childSessionKey) {
      for (const entry of params.getRunsForChildSession(childSessionKey)) {
        runIds.add(entry.runId);
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
      const existingKillIntent = entry.killIntent;
      const currentKillLifecycle =
        existingKillIntent?.lifecycleGeneration !== undefined &&
        isAgentEventLifecycleGenerationCurrent(existingKillIntent.lifecycleGeneration);
      if (
        typeof entry.execution.endedAt === "number" &&
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
      const wasQueuedCollector = entry.collect && entry.execution.status === "queued";
      const collectorLaunchInFlight =
        wasQueuedCollector &&
        entry.swarmLaunchPending === true &&
        !isSwarmRunQueued(entry.schedulerSlotId ?? entry.runId);
      if (wasQueuedCollector) {
        queuedCollectorRunIds.push(entry.runId);
      }
      const endedAt =
        (wasYielded || wasKilledLifecycle) && typeof entry.execution.endedAt === "number"
          ? entry.execution.endedAt
          : now;
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt,
        lifecycleGeneration:
          existingKillIntent && currentKillLifecycle
            ? existingKillIntent.lifecycleGeneration
            : entry.execution.lifecycleGeneration,
        restartRecovery: undefined,
        suppressSessionEffects:
          existingKillIntent && currentKillLifecycle
            ? undefined
            : entry.execution.suppressSessionEffects,
        outcome: withSubagentOutcomeTiming(
          { status: "error", error: reason },
          {
            startedAt: entry.execution.startedAt,
            endedAt,
          },
        ),
      };
      entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
      entry.cleanupHandled = true;
      entry.cleanupCompletedAt = existingKillReconciliation
        ? (entry.cleanupCompletedAt ?? endedAt)
        : wasKilledLifecycle
          ? endedAt
          : now;
      entry.suppressAnnounceReason = "killed";
      entry.pauseReason = undefined;
      entry.killIntent = undefined;
      // Terminalizing execution above short-circuits the completion watcher, so the
      // lifecycle finalizer never reaches the detached task row for killed runs.
      const taskEndedAt = existingKillIntent
        ? existingKillIntent.requestedAt
        : existingKillReconciliation
          ? (resolveKilledSubagentTaskEndedAt(entry) ?? endedAt)
          : wasYielded
            ? now
            : endedAt;
      entry.killReconciliation = {
        killedAt:
          existingKillIntent?.requestedAt ?? existingKillReconciliation?.killedAt ?? taskEndedAt,
        suppressTaskDelivery:
          existingKillIntent?.suppressTaskDelivery === true ||
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
        params.persistOrThrow(...[...entrySnapshots.keys()].map((entry) => entry.runId));
      } catch (error) {
        for (const [entry, snapshot] of entrySnapshots) {
          restoreSubagentRunRecord(entry, snapshot);
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
              isCurrentGeneration: () =>
                currentRunOwnsSession(entry) &&
                !shouldSuppressSubagentRecoverySessionEffects(entry),
              assertCommitAllowed: () => {
                if (
                  !currentRunOwnsSession(entry) ||
                  shouldSuppressSubagentRecoverySessionEffects(entry)
                ) {
                  throw new Error("killed subagent session owner retired before timing commit");
                }
              },
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
    abandonSubagentRestartRecoveryLaunch,
    claimSubagentRunKill,
    clearAcceptedSubagentRestartRecovery,
    clearSubagentRunSteerRestart,
    markSubagentRunForSteerRestart,
    markSubagentRunTerminated,
    registerSubagentRun,
    releaseSubagentRunKillClaim,
    startQueuedSubagentRun,
    failQueuedSubagentRun,
    markSubagentRestartRecoveryLaunchAccepted,
    markSubagentRestartRecoveryLaunchConsumed,
    settleFailedQueuedSubagentLaunch,
    releaseSubagentRun,
    replaceSubagentRunAfterSteer,
    markSubagentRestartRecoveryLaunchAttempted,
    reserveSubagentRestartRecoveryLaunch,
    resumeSettledSubagentRestartRecovery,
    resetSubagentRestartRecoveryLaunchAttempt,
    waitForSubagentCompletion,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
