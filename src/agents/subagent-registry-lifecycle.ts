import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/detached-task-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { retireSessionMcpRuntimeForSessionKey } from "./pi-bundle-mcp-tools.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import { shouldUpdateRunOutcome } from "./subagent-registry-completion.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  capFrozenResultText,
  logAnnounceGiveUp,
  MAX_ANNOUNCE_RETRY_COUNT,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type CaptureSubagentCompletionReply =
  (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

let browserCleanupPromise: Promise<BrowserCleanupModule> | null = null;

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  browserCleanupPromise ??= import("../browser-lifecycle-cleanup.js");
  return (await browserCleanupPromise).cleanupBrowserSessionsForLifecycleEnd;
}

export function createSubagentRegistryLifecycleController(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  persist(): void;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  shouldEmitEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }): boolean;
  emitSubagentEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
  }): Promise<void>;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted";
    workspaceDir?: string;
  }): Promise<void>;
  resumeSubagentRun(runId: string): void;
  captureSubagentCompletionReply: CaptureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
  runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
  warn(message: string, meta?: Record<string, unknown>): void;
}) {
  const scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();

  const scheduleResumeSubagentRun = (runId: string, entry: SubagentRunRecord, delayMs: number) => {
    const timer = setTimeout(() => {
      scheduledResumeTimers.delete(timer);
      if (params.runs.get(runId) !== entry) {
        return;
      }
      params.resumeSubagentRun(runId);
    }, delayMs);
    timer.unref?.();
    scheduledResumeTimers.add(timer);
  };

  const clearScheduledResumeTimers = () => {
    for (const timer of scheduledResumeTimers) {
      clearTimeout(timer);
    }
    scheduledResumeTimers.clear();
  };

  const maskRunId = (runId: string): string => {
    const trimmed = runId.trim();
    if (!trimmed) {
      return "unknown";
    }
    if (trimmed.length <= 8) {
      return "***";
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  const maskSessionKey = (sessionKey: string): string => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return "unknown";
    }
    const prefix = trimmed.split(":").slice(0, 2).join(":") || "session";
    return `${prefix}:…`;
  };

  const buildSafeLifecycleErrorMeta = (err: unknown): Record<string, string> => {
    const message = formatErrorMessage(err);
    const name = readErrorName(err);
    return name ? { name, message } : { message };
  };

  const formatAnnounceDeliveryError = (delivery: SubagentAnnounceDeliveryResult): string => {
    const errors = [
      delivery.error,
      ...(delivery.phases ?? []).map((phase) =>
        phase.error ? `${phase.phase}: ${phase.error}` : undefined,
      ),
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    return errors.length > 0
      ? [...new Set(errors)].join("; ")
      : `delivery path ${delivery.path} did not complete`;
  };

  const safeSetSubagentTaskDeliveryStatus = (args: {
    runId: string;
    childSessionKey: string;
    deliveryStatus: "delivered" | "failed";
    deliveryError?: string;
  }) => {
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: args.runId,
        runtime: "subagent",
        sessionKey: args.childSessionKey,
        deliveryStatus: args.deliveryStatus,
        error: args.deliveryStatus === "failed" ? args.deliveryError : undefined,
      });
    } catch (err) {
      params.warn("failed to update subagent background task delivery state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.runId),
        childSessionKey: maskSessionKey(args.childSessionKey),
        deliveryStatus: args.deliveryStatus,
      });
    }
  };

  const safeFinalizeSubagentTaskRun = (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
  }) => {
    const endedAt = args.entry.endedAt ?? Date.now();
    const lastEventAt = endedAt;
    try {
      if (args.outcome.status === "ok") {
        completeTaskRunByRunId({
          runId: args.entry.runId,
          runtime: "subagent",
          sessionKey: args.entry.childSessionKey,
          endedAt,
          lastEventAt,
          progressSummary: args.entry.frozenResultText ?? undefined,
          terminalSummary: null,
        });
        return;
      }
      failTaskRunByRunId({
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
        status: args.outcome.status === "timeout" ? "timed_out" : "failed",
        endedAt,
        lastEventAt,
        error: args.outcome.status === "error" ? args.outcome.error : undefined,
        progressSummary: args.entry.frozenResultText ?? undefined,
        terminalSummary: null,
      });
    } catch (err) {
      params.warn("failed to finalize subagent background task state", {
        error: buildSafeLifecycleErrorMeta(err),
        runId: maskRunId(args.entry.runId),
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        outcomeStatus: args.outcome.status,
      });
    }
  };

  const freezeRunResultAtCompletion = async (
    entry: SubagentRunRecord,
    outcome: SubagentRunOutcome,
  ): Promise<boolean> => {
    if (entry.frozenResultText !== undefined) {
      return false;
    }
    if (outcome.status === "error") {
      entry.frozenResultText = null;
      entry.frozenResultCapturedAt = Date.now();
      return true;
    }
    try {
      const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
        waitForReply: entry.expectsCompletionMessage === true,
        outcome,
      });
      entry.frozenResultText = captured?.trim() ? capFrozenResultText(captured) : null;
    } catch {
      entry.frozenResultText = null;
    }
    entry.frozenResultCapturedAt = Date.now();
    return true;
  };

  const listPendingCompletionRunsForSession = (sessionKey: string): SubagentRunRecord[] => {
    const key = sessionKey.trim();
    if (!key) {
      return [];
    }
    const out: SubagentRunRecord[] = [];
    for (const entry of params.runs.values()) {
      if (entry.childSessionKey !== key) {
        continue;
      }
      if (entry.expectsCompletionMessage !== true) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      out.push(entry);
    }
    return out;
  };

  const refreshFrozenResultFromSession = async (sessionKey: string): Promise<boolean> => {
    const candidates = listPendingCompletionRunsForSession(sessionKey).filter(
      (entry) => entry.outcome?.status !== "error",
    );
    if (candidates.length === 0) {
      return false;
    }

    let captured: string | undefined;
    try {
      captured = await params.captureSubagentCompletionReply(sessionKey);
    } catch {
      return false;
    }
    const trimmed = captured?.trim();
    if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
      return false;
    }

    const nextFrozen = capFrozenResultText(trimmed);
    const capturedAt = Date.now();
    let changed = false;
    for (const entry of candidates) {
      if (entry.frozenResultText === nextFrozen) {
        continue;
      }
      entry.frozenResultText = nextFrozen;
      entry.frozenResultCapturedAt = capturedAt;
      changed = true;
    }
    if (changed) {
      params.persist();
    }
    return changed;
  };

  const emitCompletionEndedHookIfNeeded = async (
    entry: SubagentRunRecord,
    reason: SubagentLifecycleEndedReason,
  ) => {
    if (
      entry.expectsCompletionMessage === true &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason,
      })
    ) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason,
        sendFarewell: true,
      });
    }
  };

  const finalizeResumedAnnounceGiveUp = async (giveUpParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
  }) => {
    safeSetSubagentTaskDeliveryStatus({
      runId: giveUpParams.runId,
      childSessionKey: giveUpParams.entry.childSessionKey,
      deliveryStatus: "failed",
      deliveryError: giveUpParams.entry.lastAnnounceDeliveryError,
    });
    giveUpParams.entry.wakeOnDescendantSettle = undefined;
    giveUpParams.entry.fallbackFrozenResultText = undefined;
    giveUpParams.entry.fallbackFrozenResultCapturedAt = undefined;
    const shouldDeleteAttachments =
      giveUpParams.entry.cleanup === "delete" || !giveUpParams.entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(giveUpParams.entry);
    }
    const completionReason = resolveCleanupCompletionReason(giveUpParams.entry);
    logAnnounceGiveUp(giveUpParams.entry, giveUpParams.reason);
    // Retry-limit / expiry give-up should not leave cleanup stuck behind the
    // best-effort ended hook. Mark the run cleaned first, then fire the hook.
    completeCleanupBookkeeping({
      runId: giveUpParams.runId,
      entry: giveUpParams.entry,
      cleanup: giveUpParams.entry.cleanup,
      completedAt: Date.now(),
    });
    await emitCompletionEndedHookIfNeeded(giveUpParams.entry, completionReason);
  };

  const beginSubagentCleanup = (runId: string) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return false;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      return false;
    }
    entry.cleanupHandled = true;
    params.persist();
    return true;
  };

  const retryDeferredCompletedAnnounces = (excludeRunId?: string) => {
    const now = Date.now();
    for (const [runId, entry] of params.runs.entries()) {
      if (excludeRunId && runId === excludeRunId) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (entry.cleanupCompletedAt || entry.cleanupHandled) {
        continue;
      }
      if (params.suppressAnnounceForSteerRestart(entry)) {
        continue;
      }
      const endedAgo = now - (entry.endedAt ?? now);
      if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
        if (!beginSubagentCleanup(runId)) {
          continue;
        }
        void finalizeResumedAnnounceGiveUp({
          runId,
          entry,
          reason: "expiry",
        }).catch((error) => {
          defaultRuntime.log(
            `[warn] Subagent expiry finalize failed during deferred retry for run ${runId}: ${String(error)}`,
          );
          const current = params.runs.get(runId);
          if (!current || current.cleanupCompletedAt) {
            return;
          }
          current.cleanupHandled = false;
          params.persist();
        });
        continue;
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }
  };

  const completeCleanupBookkeeping = (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
  }) => {
    if (cleanupParams.entry.spawnMode !== "session") {
      void retireSessionMcpRuntimeForSessionKey({
        sessionKey: cleanupParams.entry.childSessionKey,
        reason: "subagent-run-cleanup",
        onError: (error, sessionId) => {
          params.warn("failed to retire subagent bundle MCP runtime", {
            error: buildSafeLifecycleErrorMeta(error),
            sessionId,
            runId: maskRunId(cleanupParams.runId),
            childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
          });
        },
      });
    }
    if (cleanupParams.cleanup === "delete") {
      params.clearPendingLifecycleError(cleanupParams.runId);
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: cleanupParams.entry.childSessionKey,
        reason: "deleted",
        workspaceDir: cleanupParams.entry.workspaceDir,
      });
      params.runs.delete(cleanupParams.runId);
      params.persist();
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    void params.notifyContextEngineSubagentEnded({
      childSessionKey: cleanupParams.entry.childSessionKey,
      reason: "completed",
      workspaceDir: cleanupParams.entry.workspaceDir,
    });
    cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
    params.persist();
    retryDeferredCompletedAnnounces(cleanupParams.runId);
  };

  const retireRunModeBundleMcpRuntime = (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: string;
  }) => {
    if (cleanupParams.entry.spawnMode === "session") {
      return;
    }
    void retireSessionMcpRuntimeForSessionKey({
      sessionKey: cleanupParams.entry.childSessionKey,
      reason: cleanupParams.reason,
      onError: (error, sessionId) => {
        params.warn("failed to retire subagent bundle MCP runtime", {
          error: buildSafeLifecycleErrorMeta(error),
          sessionId,
          runId: maskRunId(cleanupParams.runId),
          childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
        });
      },
    });
  };

  const finalizeSubagentCleanup = async (
    runId: string,
    cleanup: "delete" | "keep",
    didAnnounce: boolean,
    options?: {
      skipAnnounce?: boolean;
    },
  ) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    if (didAnnounce) {
      if (!options?.skipAnnounce) {
        entry.completionAnnouncedAt = Date.now();
        params.persist();
      }
      safeSetSubagentTaskDeliveryStatus({
        runId,
        childSessionKey: entry.childSessionKey,
        deliveryStatus: "delivered",
      });
      entry.lastAnnounceDeliveryError = undefined;
      entry.wakeOnDescendantSettle = undefined;
      entry.fallbackFrozenResultText = undefined;
      entry.fallbackFrozenResultCapturedAt = undefined;
      const completionReason = resolveCleanupCompletionReason(entry);
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (cleanup === "delete") {
        entry.frozenResultText = undefined;
        entry.frozenResultCapturedAt = undefined;
      }
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: Date.now(),
      });
      return;
    }

    const now = Date.now();
    const deferredDecision = resolveDeferredCleanupDecision({
      entry,
      now,
      activeDescendantRuns: Math.max(0, params.countPendingDescendantRuns(entry.childSessionKey)),
      announceExpiryMs: ANNOUNCE_EXPIRY_MS,
      announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
      maxAnnounceRetryCount: MAX_ANNOUNCE_RETRY_COUNT,
      deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
      resolveAnnounceRetryDelayMs,
    });

    if (deferredDecision.kind === "defer-descendants") {
      entry.lastAnnounceRetryAt = now;
      entry.wakeOnDescendantSettle = true;
      entry.cleanupHandled = false;
      params.resumedRuns.delete(runId);
      params.persist();
      scheduleResumeSubagentRun(runId, entry, deferredDecision.delayMs);
      return;
    }

    if (deferredDecision.retryCount != null) {
      entry.announceRetryCount = deferredDecision.retryCount;
      entry.lastAnnounceRetryAt = now;
    }

    if (deferredDecision.kind === "give-up") {
      safeSetSubagentTaskDeliveryStatus({
        runId,
        childSessionKey: entry.childSessionKey,
        deliveryStatus: "failed",
        deliveryError: entry.lastAnnounceDeliveryError,
      });
      entry.wakeOnDescendantSettle = undefined;
      entry.fallbackFrozenResultText = undefined;
      entry.fallbackFrozenResultCapturedAt = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      const completionReason = resolveCleanupCompletionReason(entry);
      logAnnounceGiveUp(entry, deferredDecision.reason);
      // Giving up on announce delivery is terminal for cleanup even if the
      // best-effort hook is still resolving.
      completeCleanupBookkeeping({
        runId,
        entry,
        cleanup,
        completedAt: now,
      });
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      return;
    }

    entry.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    params.persist();
    if (deferredDecision.resumeDelayMs == null) {
      return;
    }
    scheduleResumeSubagentRun(runId, entry, deferredDecision.resumeDelayMs);
  };

  const startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean => {
    if (typeof entry.completionAnnouncedAt === "number") {
      if (!beginSubagentCleanup(runId)) {
        return false;
      }
      void finalizeSubagentCleanup(runId, entry.cleanup, true, {
        skipAnnounce: true,
      }).catch((err) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
      return true;
    }
    if (!beginSubagentCleanup(runId)) {
      return false;
    }
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    let latestDeliveryError = entry.lastAnnounceDeliveryError;
    const finalizeAnnounceCleanup = (didAnnounce: boolean) => {
      if (!didAnnounce && latestDeliveryError) {
        entry.lastAnnounceDeliveryError = latestDeliveryError;
      }
      void finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce).catch((err) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
    };

    void params
      .runSubagentAnnounceFlow({
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
        requesterSessionKey: entry.requesterSessionKey,
        requesterOrigin,
        requesterDisplayKey: entry.requesterDisplayKey,
        task: entry.task,
        timeoutMs: params.subagentAnnounceTimeoutMs,
        cleanup: entry.cleanup,
        roundOneReply: entry.frozenResultText ?? undefined,
        fallbackReply: entry.fallbackFrozenResultText ?? undefined,
        waitForCompletion: false,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        label: entry.label,
        outcome: entry.outcome,
        spawnMode: entry.spawnMode,
        expectsCompletionMessage: entry.expectsCompletionMessage,
        wakeOnDescendantSettle: entry.wakeOnDescendantSettle === true,
        onDeliveryResult: (delivery) => {
          if (delivery.delivered) {
            if (entry.lastAnnounceDeliveryError !== undefined) {
              entry.lastAnnounceDeliveryError = undefined;
              params.persist();
            }
            latestDeliveryError = undefined;
            return;
          }
          latestDeliveryError = formatAnnounceDeliveryError(delivery);
          if (entry.lastAnnounceDeliveryError !== latestDeliveryError) {
            entry.lastAnnounceDeliveryError = latestDeliveryError;
            params.persist();
          }
        },
      })
      .then((didAnnounce) => {
        finalizeAnnounceCleanup(didAnnounce);
      })
      .catch((error) => {
        defaultRuntime.log(
          `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
        );
        finalizeAnnounceCleanup(false);
      });
    return true;
  };

  const completeSubagentRun = async (completeParams: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
  }) => {
    params.clearPendingLifecycleError(completeParams.runId);
    const entry = params.runs.get(completeParams.runId);
    if (!entry) {
      return;
    }

    let mutated = false;
    if (
      completeParams.reason === SUBAGENT_ENDED_REASON_COMPLETE &&
      entry.suppressAnnounceReason === "killed" &&
      (entry.cleanupHandled || typeof entry.cleanupCompletedAt === "number")
    ) {
      entry.suppressAnnounceReason = undefined;
      entry.cleanupHandled = false;
      entry.cleanupCompletedAt = undefined;
      entry.completionAnnouncedAt = undefined;
      mutated = true;
    }

    const endedAt =
      typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
    if (entry.endedAt !== endedAt) {
      entry.endedAt = endedAt;
      mutated = true;
    }
    const outcome = withSubagentOutcomeTiming(completeParams.outcome, {
      startedAt: entry.startedAt,
      endedAt,
    });
    if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
      entry.outcome = outcome;
      mutated = true;
    }
    if (entry.endedReason !== completeParams.reason) {
      entry.endedReason = completeParams.reason;
      mutated = true;
    }
    if (entry.pauseReason !== undefined) {
      entry.pauseReason = undefined;
      mutated = true;
    }

    if (await freezeRunResultAtCompletion(entry, outcome)) {
      mutated = true;
    }

    if (mutated) {
      params.persist();
    }
    safeFinalizeSubagentTaskRun({
      entry,
      outcome,
    });

    try {
      await persistSubagentSessionTiming(entry);
    } catch (err) {
      params.warn("failed to persist subagent session timing", {
        err,
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      });
    }

    const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
    if (mutated && !suppressedForSteerRestart) {
      emitSessionLifecycleEvent({
        sessionKey: entry.childSessionKey,
        reason: "subagent-status",
        parentSessionKey: entry.requesterSessionKey,
        label: entry.label,
      });
    }
    const shouldEmitEndedHook =
      !suppressedForSteerRestart &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason: completeParams.reason,
      });
    const shouldDeferEndedHook =
      shouldEmitEndedHook &&
      completeParams.triggerCleanup &&
      entry.expectsCompletionMessage === true &&
      !suppressedForSteerRestart;
    if (!shouldDeferEndedHook && shouldEmitEndedHook) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason: completeParams.reason,
        sendFarewell: completeParams.sendFarewell,
        accountId: completeParams.accountId,
      });
    }

    if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
      return;
    }

    const cleanupBrowserSessions =
      params.cleanupBrowserSessionsForLifecycleEnd ??
      (await loadCleanupBrowserSessionsForLifecycleEnd());
    await cleanupBrowserSessions({
      sessionKeys: [entry.childSessionKey],
      onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
    });

    retireRunModeBundleMcpRuntime({
      runId: completeParams.runId,
      entry,
      reason: "subagent-run-complete",
    });

    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  return {
    clearScheduledResumeTimers,
    completeCleanupBookkeeping,
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp,
    refreshFrozenResultFromSession,
    startSubagentAnnounceCleanupFlow,
  };
}
