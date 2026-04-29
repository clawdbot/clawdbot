import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createRunningTaskRun } from "../tasks/detached-task-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { isRecoverableAgentWaitError, waitForAgentRun } from "./run-wait.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
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

const log = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 25 : 5_000;

function shouldDeleteAttachments(entry: SubagentRunRecord) {
  return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
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
  if (entry.frozenResultText !== undefined) {
    entry.frozenResultText = undefined;
    entry.frozenResultCapturedAt = undefined;
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
  }): Promise<void>;
}) {
  const waitForSubagentCompletion = async (
    runId: string,
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
  ) => {
    try {
      const wait = await waitForAgentRun({
        runId,
        timeoutMs: Math.max(1, Math.floor(waitTimeoutMs)),
        callGateway: params.callGateway,
      });
      const entry = params.runs.get(runId);
      if (!entry || (expectedEntry && entry !== expectedEntry)) {
        return;
      }
      if (wait.status === "pending") {
        return;
      }
      if (wait.yielded === true) {
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
      if (wait.status === "error" && isRecoverableAgentWaitError(wait.error)) {
        log.info("subagent wait interrupted; scheduling recovery", {
          runId,
          childSessionKey: expectedEntry?.childSessionKey ?? entry?.childSessionKey,
          error: wait.error,
        });
        params.scheduleOrphanRecovery({ delayMs: 1_000 });
        const scheduledEntry = entry;
        setTimeout(() => {
          if (!scheduledEntry) {
            return;
          }
          const current = params.runs.get(runId);
          if (!current || current !== scheduledEntry || typeof current.endedAt === "number") {
            return;
          }
          void waitForSubagentCompletion(runId, waitTimeoutMs, scheduledEntry);
        }, RECOVERABLE_WAIT_RETRY_DELAY_MS).unref?.();
        return;
      }
      let mutated = false;
      if (typeof wait.startedAt === "number") {
        entry.startedAt = wait.startedAt;
        if (typeof entry.sessionStartedAt !== "number") {
          entry.sessionStartedAt = wait.startedAt;
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
      const waitError = typeof wait.error === "string" ? wait.error : undefined;
      const baseOutcome: SubagentRunOutcome =
        wait.status === "error"
          ? { status: "error", error: waitError }
          : wait.status === "timeout"
            ? { status: "timeout" }
            : { status: "ok" };
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
      await params.completeSubagentRun({
        runId,
        endedAt: entry.endedAt,
        outcome,
        reason:
          wait.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      });
    } catch {
      // ignore
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

    const next: SubagentRunRecord = {
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
      frozenResultText: undefined,
      frozenResultCapturedAt: undefined,
      fallbackFrozenResultText: preserveFrozenResultFallback ? source.frozenResultText : undefined,
      fallbackFrozenResultCapturedAt: preserveFrozenResultFallback
        ? source.frozenResultCapturedAt
        : undefined,
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      completionAnnouncedAt: undefined,
      suppressAnnounceReason: undefined,
      announceRetryCount: undefined,
      lastAnnounceRetryAt: undefined,
      spawnMode,
      archiveAtMs,
      runTimeoutSeconds,
    };

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
    const entry: SubagentRunRecord = {
      runId,
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      task: registerParams.task,
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
      sessionStartedAt: now,
      accumulatedRuntimeMs: 0,
      archiveAtMs,
      cleanupHandled: false,
      completionAnnouncedAt: undefined,
      wakeOnDescendantSettle: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    };
    params.runs.set(runId, entry);
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
