import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { waitForAgentRun } from "./run-wait.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { emitSubagentEndedHookOnce, runOutcomesEqual } from "./subagent-registry-completion.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  persistSubagentSessionTiming,
  resolveArchiveAfterMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-registry");

function shouldDeleteAttachments(entry: SubagentRunRecord) {
  return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
}

export function createSubagentRunManager(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  endedHookInFlightRunIds: Set<string>;
  persist(): void;
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
  ensureRuntimePluginsLoaded:
    | typeof ensureRuntimePluginsLoadedFn
    | ((args: {
        config: ReturnType<typeof loadConfig>;
        workspaceDir?: string;
        allowGatewaySubagentBinding?: boolean;
      }) => void | Promise<void>);
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
  resolveSubagentWaitTimeoutMs(
    cfg: ReturnType<typeof loadConfig>,
    runTimeoutSeconds?: number,
  ): number;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted" | "released";
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
  const waitForSubagentCompletion = async (runId: string, waitTimeoutMs: number) => {
    try {
      const wait = await waitForAgentRun({
        runId,
        timeoutMs: Math.max(1, Math.floor(waitTimeoutMs)),
        callGateway: params.callGateway,
      });
      const entry = params.runs.get(runId);
      if (!entry) {
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
      const outcome: SubagentRunOutcome =
        wait.status === "error"
          ? { status: "error", error: waitError }
          : wait.status === "timeout"
            ? { status: "timeout" }
            : { status: "ok" };
      if (!runOutcomesEqual(entry.outcome, outcome)) {
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
    const cfg = params.loadConfig();
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
    void waitForSubagentCompletion(nextRunId, waitTimeoutMs);
    return true;
  };

  const registerSubagentRun = (registerParams: {
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
    workspaceDir?: string;
    runTimeoutSeconds?: number;
    expectsCompletionMessage?: boolean;
    spawnMode?: "run" | "session";
    attachmentsDir?: string;
    attachmentsRootDir?: string;
    retainAttachmentsOnKeep?: boolean;
  }) => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const now = Date.now();
    const cfg = params.loadConfig();
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
    params.runs.set(runId, {
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
    });
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
    void waitForSubagentCompletion(runId, waitTimeoutMs);
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
      entry.outcome = { status: "error", error: reason };
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
        const cfg = params.loadConfig();
        void Promise.resolve(
          params.ensureRuntimePluginsLoaded({
            config: cfg,
            workspaceDir: entry.workspaceDir,
            allowGatewaySubagentBinding: true,
          }),
        )
          .then(() =>
            emitSubagentEndedHookOnce({
              entry,
              reason: SUBAGENT_ENDED_REASON_KILLED,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
              error: reason,
              inFlightRunIds: params.endedHookInFlightRunIds,
              persist: () => params.persist(),
            }),
          )
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
