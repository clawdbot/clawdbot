import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createRunningTaskRun } from "../tasks/detached-task-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "./agent-run-terminal-outcome.js";
import { removeInternalSessionEffectsTranscript } from "./internal-session-effects.js";
import { isRecoverableAgentWaitError, waitForAgentRun } from "./run-wait.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  normalizeSubagentRunState,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  shouldUpdateRunOutcome,
} from "./subagent-registry-completion.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  persistSubagentSessionTiming,
  resolveArchiveAfterMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import type { SubagentSessionCompletion } from "./subagent-session-reconciliation.js";

const log = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 25 : 5_000;
const WAIT_TIMEOUT_DEADLINE_SKEW_MS = 250;

function shouldDeleteAttachments(entry: SubagentRunRecord) {
  return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
}

function resolveSubagentRunDeadlineMs(
  entry: SubagentRunRecord,
  observedStartedAt?: number,
): number | undefined {
  const timeoutSeconds = entry.runTimeoutSeconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return undefined;
  }
  const startedAt =
    typeof observedStartedAt === "number" && Number.isFinite(observedStartedAt)
      ? observedStartedAt
      : typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)
        ? entry.startedAt
        : entry.createdAt;
  if (!Number.isFinite(startedAt)) {
    return undefined;
  }
  return startedAt + Math.floor(timeoutSeconds * 1000);
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
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
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
};

export function createSubagentRunManager(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  endedHookInFlightRunIds: Set<string>;
  persist(): void;
  persistOrThrow(): void;
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  ensureRuntimePluginsLoaded:
    | typeof ensureRuntimePluginsLoadedFn
    | ((args: {
        config: OpenClawConfig;
        workspaceDir?: string;
        allowGatewaySubagentBinding?: boolean;
      }) => void | Promise<void>);
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
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
}) {
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
        if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
          entry.startedAt = startedAt;
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = startedAt;
          }
        }
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
        if (observedStartedAt !== undefined && entry.startedAt !== observedStartedAt) {
          entry.startedAt = observedStartedAt;
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = observedStartedAt;
          }
          params.persist();
        }
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
      let mutated = false;
      if (typeof observedStartedAt === "number") {
        entry.startedAt = observedStartedAt;
        if (typeof entry.sessionStartedAt !== "number") {
          entry.sessionStartedAt = observedStartedAt;
        }
        mutated = true;
      }
      if (typeof wait.endedAt === "number") {
        entry.endedAt = wait.endedAt;
        mutated = true;
      }
      if (!entry.endedAt) {
        entry.endedAt = Date.now();
        mutated = true;
      }
      const rawWaitError = typeof wait.error === "string" ? wait.error : undefined;
      const waitError = waitAborted
        ? "subagent run terminated"
        : (waitTerminalOutcome?.error ?? rawWaitError);
      const baseOutcome: SubagentRunOutcome =
        waitStatus === "error" ? { status: "error", error: waitError } : { status: "ok" };
      const outcome = withSubagentOutcomeTiming(baseOutcome, {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
      });
      if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
        entry.outcome = outcome;
        mutated = true;
      }
      if (mutated) {
        params.persist();
      }
      completionForRetry = {
        runId,
        endedAt: entry.endedAt,
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
      if (
        current &&
        typeof current.endedAt === "number" &&
        !current.cleanupCompletedAt &&
        current.pauseReason !== "sessions_yield"
      ) {
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
        current.cleanupHandled = false;
        params.resumedRuns.delete(runId);
        params.resumeSubagentRun(runId);
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
    transcriptFile?: string;
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

    if (previousRunId !== nextRunId) {
      params.clearPendingLifecycleError(previousRunId);
      if (shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      if (
        source.execution?.transcriptFile &&
        source.execution.transcriptFile !== replaceParams.transcriptFile
      ) {
        void removeInternalSessionEffectsTranscript(source.execution.transcriptFile);
      }
      params.runs.delete(previousRunId);
      params.resumedRuns.delete(previousRunId);
    }

    const now = Date.now();
    const cfg = params.getRuntimeConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || source.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
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
    const next: SubagentRunRecord = normalizeSubagentRunState({
      ...source,
      runId: nextRunId,
      createdAt: now,
      startedAt: now,
      sessionStartedAt,
      accumulatedRuntimeMs,
      endedAt: undefined,
      endedReason: undefined,
      pauseReason: undefined,
      endedHookEmittedAt: undefined,
      wakeOnDescendantSettle: undefined,
      outcome: undefined,
      execution: {
        status: "running",
        startedAt: now,
        transcriptFile: replaceParams.transcriptFile,
      },
      completion: {
        required: source.expectsCompletionMessage === true,
        fallbackResultText: preserveFrozenResultFallback ? sourceCompletion.resultText : undefined,
        fallbackCapturedAt: preserveFrozenResultFallback ? sourceCompletion.capturedAt : undefined,
      },
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      suppressAnnounceReason: undefined,
      delivery: {
        status: source.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      spawnMode,
      archiveAtMs,
      runTimeoutSeconds,
    });
    clearDeliveryState(next);

    params.runs.set(nextRunId, next);
    params.ensureListener();
    params.persist();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    void waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
    return true;
  };

  const registerSubagentRun = (registerParams: RegisterSubagentRunParams) => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const now = Date.now();
    const cfg = params.getRuntimeConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || registerParams.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const entry: SubagentRunRecord = normalizeSubagentRunState({
      runId,
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
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
      createdAt: now,
      startedAt: now,
      execution: {
        status: "running",
        startedAt: now,
      },
      completion: {
        required: registerParams.expectsCompletionMessage === true,
      },
      delivery: {
        status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      sessionStartedAt: now,
      accumulatedRuntimeMs: 0,
      archiveAtMs,
      cleanupHandled: false,
      wakeOnDescendantSettle: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    });
    params.runs.set(runId, entry);
    try {
      params.persistOrThrow();
    } catch (error) {
      params.runs.delete(runId);
      throw error;
    }
    try {
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: requesterSessionKey,
        scopeKind: "session",
        requesterOrigin,
        childSessionKey,
        runId,
        label: registerParams.label,
        task: registerParams.task,
        deliveryStatus:
          registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
        startedAt: now,
        lastEventAt: now,
      });
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
    void waitForSubagentCompletion(runId, waitTimeoutMs, entry);
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
    for (const runId of runIds) {
      params.clearPendingLifecycleError(runId);
      const entry = params.runs.get(runId);
      if (!entry) {
        continue;
      }
      if (typeof entry.endedAt === "number") {
        continue;
      }
      entry.endedAt = now;
      entry.outcome = withSubagentOutcomeTiming(
        { status: "error", error: reason },
        {
          startedAt: entry.startedAt,
          endedAt: now,
        },
      );
      entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
      entry.cleanupHandled = true;
      entry.cleanupCompletedAt = now;
      entry.suppressAnnounceReason = "killed";
      if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
        entriesByChildSessionKey.set(entry.childSessionKey, entry);
      }
      updated += 1;
    }
    if (updated > 0) {
      params.persist();
      for (const entry of entriesByChildSessionKey.values()) {
        const emitEndedHook = () =>
          emitSubagentEndedHookOnce({
            entry,
            reason: SUBAGENT_ENDED_REASON_KILLED,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
            error: reason,
            inFlightRunIds: params.endedHookInFlightRunIds,
            persist: () => params.persist(),
          });
        void persistSubagentSessionTiming(entry).catch((err) => {
          log.warn("failed to persist killed subagent session timing", {
            err,
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          });
        });
        if (shouldDeleteAttachments(entry)) {
          void safeRemoveAttachmentsDir(entry);
        }
        params.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: entry.cleanup,
          completedAt: now,
        });
        if (getGlobalHookRunner()) {
          void emitEndedHook().catch(() => {
            // Hook failures should not break termination flow.
          });
          continue;
        }
        const cfg = params.getRuntimeConfig();
        void Promise.resolve(
          params.ensureRuntimePluginsLoaded({
            config: cfg,
            workspaceDir: entry.workspaceDir,
            allowGatewaySubagentBinding: true,
          }),
        )
          .then(emitEndedHook)
          .catch(() => {
            // Hook failures should not break termination flow.
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
    releaseSubagentRun,
    replaceSubagentRunAfterSteer,
    waitForSubagentCompletion,
  };
}
