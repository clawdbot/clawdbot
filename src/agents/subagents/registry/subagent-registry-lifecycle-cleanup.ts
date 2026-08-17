import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { recordSubagentTerminalState } from "../../../sessions/session-state-events.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import {
  logAnnounceGiveUp,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleCommonContext,
  SubagentLifecycleCompletionContext,
  SubagentLifecycleCleanupContext,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  markPendingFinalDelivery,
  maskLifecycleIdentifier,
  safeMarkRequiredCompletionDeliveryBlocked,
  safeSetSubagentTaskDeliveryStatus,
} from "./subagent-registry-lifecycle-delivery.js";
import {
  markRequesterSettleWakePending,
  scheduleRequesterSettleWake,
} from "./subagent-registry-lifecycle-wake.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const MAX_DETACHED_CLEANUP_RETRIES = 3;
type BrowserCleanup = typeof cleanupBrowserSessionsForLifecycleEnd;

export function scheduleResumeSubagentRun(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  delayMs: number,
  cleanupGeneration?: number,
): void {
  const params = context.options;
  const timer = setTimeout(() => {
    context.deleteScheduledResumeTimer(timer);
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (params.runs.get(runId) !== entry) {
        return;
      }
      if (cleanupGeneration !== undefined) {
        if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
          return;
        }
        if (entry.cleanupHandled) {
          entry.cleanupHandled = false;
          params.persist(runId);
        }
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }).catch((err: unknown) => {
      defaultRuntime.log(`[warn] subagent cleanup resume failed (${runId}): ${String(err)}`);
      const current = params.runs.get(runId);
      if (
        isGatewayRestartDraining() &&
        current === entry &&
        typeof current.cleanupCompletedAt !== "number"
      ) {
        scheduleResumeSubagentRun(
          context,
          runId,
          entry,
          Math.max(delayMs, MIN_ANNOUNCE_RETRY_DELAY_MS),
          cleanupGeneration,
        );
      }
    });
  }, delayMs);
  timer.unref?.();
  context.addScheduledResumeTimer(timer);
}

export function runDetachedCleanupAttempt(
  context: SubagentLifecycleCleanupContext,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanupGeneration: number;
    run: () => Promise<void>;
  },
): void {
  const params = context.options;
  // Completion makes the task projection non-blocking before delivery and
  // cleanup finish. This independent lease bridges that handoff and owns the
  // full detached attempt, including its final durable registry write.
  // Completion outlives the spawning attempt; inherited lock owners would
  // reject requester transcript writes after that attempt is disposed.
  runWithoutOwnedSessionTranscriptWrites(() => {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      try {
        await args.run();
        context.clearCleanupFailureCount(args.entry);
      } catch (err) {
        defaultRuntime.log(
          `[warn] subagent cleanup finalize failed (${args.runId}): ${String(err)}`,
        );
        const current = params.runs.get(args.runId);
        if (
          !current ||
          current.cleanupCompletedAt ||
          !context.isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
        ) {
          return;
        }
        current.cleanupHandled = false;
        params.resumedRuns.delete(args.runId);
        params.persist(args.runId);
        const failureCount = context.incrementCleanupFailureCount(current);
        if (failureCount <= MAX_DETACHED_CLEANUP_RETRIES) {
          scheduleResumeSubagentRun(
            context,
            args.runId,
            current,
            resolveAnnounceRetryDelayMs(failureCount),
            args.cleanupGeneration,
          );
        }
      }
    }).catch((err: unknown) => {
      defaultRuntime.log(
        `[warn] subagent cleanup admission failed (${args.runId}): ${String(err)}`,
      );
      if (isGatewayRestartDraining()) {
        scheduleResumeSubagentRun(
          context,
          args.runId,
          args.entry,
          MIN_ANNOUNCE_RETRY_DELAY_MS,
          args.cleanupGeneration,
        );
      }
    });
  });
}

export function suspendPendingFinalDelivery(
  context: SubagentLifecycleCleanupContext & SubagentLifecycleWakeContext,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
    error?: string;
  },
): void {
  const params = context.options;
  const previousEntry = structuredClone(args.entry);
  markPendingFinalDelivery({
    entry: args.entry,
    error: args.error ?? getDeliveryLastError(args.entry) ?? args.reason,
  });
  const now = Date.now();
  const delivery = ensureDeliveryState(args.entry);
  delivery.status = "suspended";
  delivery.suspendedAt ??= now;
  delivery.suspendedReason = args.reason;
  args.entry.cleanupHandled = false;
  args.entry.wakeOnDescendantSettle = undefined;
  const completion = ensureCompletionState(args.entry);
  completion.fallbackResultText = undefined;
  completion.fallbackCapturedAt = undefined;
  params.resumedRuns.delete(args.runId);
  safeSetSubagentTaskDeliveryStatus(params, {
    entry: args.entry,
    deliveryStatus: "failed",
    deliveryError: getDeliveryLastError(args.entry) ?? args.reason,
  });
  safeMarkRequiredCompletionDeliveryBlocked(params, {
    entry: args.entry,
    reason: getDeliveryLastError(args.entry) ?? args.reason,
  });
  logAnnounceGiveUp(args.entry, args.reason);
  markRequesterSettleWakePending(args.entry);
  try {
    params.persistOrThrow(args.runId);
  } catch (error) {
    for (const key of Object.keys(args.entry)) {
      Reflect.deleteProperty(args.entry, key);
    }
    Object.assign(args.entry, previousEntry);
    throw error;
  }
  // Suspension is terminal for automatic retries, so it settles this child
  // for requester-drain purposes even though cleanup stays incomplete.
  scheduleRequesterSettleWake(context, args.runId, args.entry);
}

export function beginSubagentCleanup(
  context: SubagentLifecycleCleanupContext,
  runId: string,
): number | undefined {
  const params = context.options;
  const entry = params.runs.get(runId);
  if (!entry || entry.cleanupCompletedAt || entry.cleanupHandled) {
    return undefined;
  }
  entry.cleanupHandled = true;
  const generation = context.bumpCleanupGeneration(entry);
  params.persist(runId);
  return generation;
}

export async function retireSupersededCleanupIfNeeded(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): Promise<boolean> {
  const params = context.options;
  if (
    params.runs.get(runId) !== entry ||
    !context.isCleanupGeneration(entry, generation) ||
    !context.newerGenerationOwnsSession(entry)
  ) {
    return false;
  }
  // Cleanup can yield to attachment, mirror, or announce work. A successor
  // registered while it was suspended owns every session-scoped side effect.
  await params.retireSupersededRun(runId, entry);
  return true;
}

export function retireSupersededCleanupInBackground(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): void {
  // Delivery callbacks are synchronous and may arrive after their announce
  // attempt returns. Give the async retirement tail its own snapshot blocker.
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    await retireSupersededCleanupIfNeeded(context, runId, entry, generation);
  }).catch((error: unknown) => {
    defaultRuntime.log(
      `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
    );
  });
}

async function retireRunModeBundleMcpRuntime(
  context: SubagentLifecycleCommonContext,
  cleanupParams: { runId: string; entry: SubagentRunRecord; reason: string },
): Promise<void> {
  const params = context.options;
  if (cleanupParams.entry.spawnMode === "session") {
    return;
  }
  await retireSessionMcpRuntimeForSessionKey({
    sessionKey: cleanupParams.entry.childSessionKey,
    reason: cleanupParams.reason,
    preserveActiveLeases: true,
    onError: (error, sessionId) => {
      params.warn("failed to retire subagent bundle MCP runtime", {
        error: buildSafeLifecycleErrorMeta(error),
        sessionId,
        runId: maskLifecycleIdentifier(cleanupParams.runId, "run"),
        childSessionKey: maskLifecycleIdentifier(cleanupParams.entry.childSessionKey, "session"),
      });
    },
  });
}

export async function completeTerminalEffects(
  context: SubagentLifecycleCompletionContext,
  args: {
    completeParams: SubagentCompletionRequest;
    completionReason: SubagentLifecycleEndedReason;
    entry: SubagentRunRecord;
    mutated: boolean;
    sessionSuperseded: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<BrowserCleanup>;
  },
): Promise<void> {
  const params = context.options;
  const { completeParams, completionReason, entry, mutated, terminalGeneration } = args;
  let { sessionSuperseded, suppressSessionEffects } = args;
  const isCurrentTerminalCallback = () =>
    context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration);
  const isCurrentSessionEffectsOwner = () =>
    isCurrentTerminalCallback() &&
    !context.newerGenerationOwnsSession(entry) &&
    !shouldSuppressSubagentRecoverySessionEffects(entry);
  const refreshSessionEffectsSuppression = () => {
    if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
      return false;
    }
    suppressSessionEffects = true;
    if (entry.execution.suppressSessionEffects !== true) {
      const previousExecution = entry.execution;
      entry.execution = { ...entry.execution, suppressSessionEffects: true };
      try {
        params.persistOrThrow(completeParams.runId);
      } catch (error) {
        entry.execution = previousExecution;
        suppressSessionEffects = false;
        throw error;
      }
    }
    return true;
  };
  if (!isCurrentTerminalCallback()) {
    return;
  }
  const retireSupersededSession = async (currentEntry: SubagentRunRecord) => {
    if (completionReason !== SUBAGENT_ENDED_REASON_KILLED) {
      await params.retireSupersededRun(completeParams.runId, currentEntry);
    }
  };
  sessionSuperseded ||= context.newerGenerationOwnsSession(entry);
  if (sessionSuperseded) {
    // This callback belongs to an older run that shared the session key.
    // Update only its task projection; the newer generation owns all session effects.
    await retireSupersededSession(entry);
    return;
  }
  if (entry.collect) {
    releaseSwarmRun(entry.schedulerSlotId ?? entry.runId);
  }
  refreshSessionEffectsSuppression();
  const isProvisionalKill = entry.killReconciliation !== undefined;
  // Record only the current, non-superseded callback with a committed outcome; the
  // run-terminal dedupe key is first-write-wins, so a provisional/stale status here
  // would permanently mislabel the signal-log terminal kind.
  const outcomeStatus = entry.execution.outcome?.status;
  if (
    !suppressSessionEffects &&
    !isProvisionalKill &&
    outcomeStatus &&
    outcomeStatus !== "unknown"
  ) {
    recordSubagentTerminalState({
      childSessionKey: entry.childSessionKey,
      runId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      outcomeStatus,
    });
  }

  if (!suppressSessionEffects) {
    try {
      const assertSessionEffectsOwnerCurrent = () => {
        if (!isCurrentSessionEffectsOwner()) {
          throw new Error("subagent session-effects owner retired before session commit");
        }
      };
      await persistSubagentSessionTiming(entry, {
        // Recheck while patchSessionEntry owns its write lock so this old
        // completion cannot commit after a synchronous ownership transfer.
        isCurrentGeneration: isCurrentSessionEffectsOwner,
        assertCommitAllowed: assertSessionEffectsOwnerCurrent,
      });
    } catch (err) {
      params.warn("failed to persist subagent session timing", {
        err,
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      });
    }
  }
  refreshSessionEffectsSuppression();
  if (!isCurrentTerminalCallback()) {
    return;
  }
  if (context.newerGenerationOwnsSession(entry)) {
    await retireSupersededSession(entry);
    return;
  }

  const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
  // Recovery persists its terminal state before draining this callback, so an
  // unchanged row still needs its first session-status and progress events.
  const shouldPublishTerminalStatus =
    mutated ||
    (completeParams.recoverInterrupted === true &&
      !isProvisionalKill &&
      !context.hasProgressEnded(entry));
  if (shouldPublishTerminalStatus && !suppressedForSteerRestart && !suppressSessionEffects) {
    emitSessionLifecycleEvent({
      sessionKey: entry.childSessionKey,
      reason: "subagent-status",
      parentSessionKey: entry.requesterSessionKey,
      label: entry.label,
    });
    // The enclosing steer/session-effects guard admits only the real terminal generation.
    if (!isProvisionalKill && !context.hasProgressEnded(entry)) {
      context.markProgressEnded(entry);
      await params.emitSubagentProgressEndedForRun(entry);
      refreshSessionEffectsSuppression();
      if (!isCurrentTerminalCallback()) {
        return;
      }
    }
  }
  const shouldEmitEndedHook =
    !suppressedForSteerRestart &&
    !isProvisionalKill &&
    !suppressSessionEffects &&
    params.shouldEmitEndedHookForRun({ entry, reason: completionReason });
  const shouldDeferEndedHook =
    shouldEmitEndedHook &&
    completeParams.triggerCleanup &&
    entry.expectsCompletionMessage === true &&
    !suppressedForSteerRestart;
  if (!shouldDeferEndedHook && shouldEmitEndedHook) {
    await params.emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: completeParams.sendFarewell,
      accountId: completeParams.accountId,
      isCurrent: isCurrentSessionEffectsOwner,
    });
    refreshSessionEffectsSuppression();
    if (!isCurrentTerminalCallback()) {
      return;
    }
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
  }

  refreshSessionEffectsSuppression();
  await completeTerminalCleanup(context, {
    completeParams,
    entry,
    isProvisionalKill,
    retireSupersededSession,
    suppressedForSteerRestart,
    suppressSessionEffects,
    terminalGeneration,
    loadCleanupBrowserSessionsForLifecycleEnd: () =>
      args.loadCleanupBrowserSessionsForLifecycleEnd(),
  });
}

async function completeTerminalCleanup(
  context: SubagentLifecycleCompletionContext,
  args: {
    completeParams: SubagentCompletionRequest;
    entry: SubagentRunRecord;
    isProvisionalKill: boolean;
    retireSupersededSession: (entry: SubagentRunRecord) => Promise<void>;
    suppressedForSteerRestart: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<BrowserCleanup>;
  },
): Promise<void> {
  const params = context.options;
  const {
    completeParams,
    entry,
    isProvisionalKill,
    retireSupersededSession,
    suppressedForSteerRestart,
    terminalGeneration,
  } = args;
  let { suppressSessionEffects } = args;
  // Session cleanup belongs to the exact registry row and child generation.
  // A replacement may reuse either the run id or the child session key.
  const isSessionEffectsOwnerCurrent = () =>
    context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration) &&
    !context.newerGenerationOwnsSession(entry);
  const refreshSessionEffectsSuppression = () => {
    if (
      suppressSessionEffects ||
      !isSessionEffectsOwnerCurrent() ||
      !shouldSuppressSubagentRecoverySessionEffects(entry)
    ) {
      return suppressSessionEffects;
    }
    const previousExecution = entry.execution;
    entry.execution = { ...previousExecution, suppressSessionEffects: true };
    try {
      params.persistOrThrow(completeParams.runId);
    } catch (error) {
      entry.execution = previousExecution;
      throw error;
    }
    suppressSessionEffects = true;
    return true;
  };
  if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
    return;
  }
  refreshSessionEffectsSuppression();
  if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
    return;
  }
  if (context.newerGenerationOwnsSession(entry)) {
    await retireSupersededSession(entry);
    return;
  }

  // registerSubagentRun fires both an in-process listener and a gateway
  // waitForSubagentCompletion RPC; both can reach this point for the same
  // runId in embedded mode. Dedupe only the browser driver tab-close IPC
  // with a sync check-then-set. The retire + announce tail below must still
  // run for every caller, so a slow or held first browser cleanup cannot
  // strand a duplicate caller's completion behind it.
  if (!suppressSessionEffects && entry.browserCleanupDispatchedAt === undefined) {
    let dispatchedBrowserCleanup = false;
    let cleanupBrowserSessions: typeof cleanupBrowserSessionsForLifecycleEnd | undefined =
      params.cleanupBrowserSessionsForLifecycleEnd;
    try {
      cleanupBrowserSessions ??= await args.loadCleanupBrowserSessionsForLifecycleEnd();
    } catch (error) {
      params.warn("failed to load browser cleanup for completed subagent", {
        error: buildSafeLifecycleErrorMeta(error),
        runId: maskLifecycleIdentifier(completeParams.runId, "run"),
        childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
      });
    }
    if (cleanupBrowserSessions) {
      if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      if (context.newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
      if (refreshSessionEffectsSuppression()) {
        return;
      }
      // Claim only when this caller is about to dispatch. A concurrent caller
      // may have claimed while the lazy browser module was loading.
      if (entry.browserCleanupDispatchedAt === undefined) {
        entry.browserCleanupDispatchedAt = Date.now();
        dispatchedBrowserCleanup = true;
        try {
          await cleanupBrowserSessions({
            sessionKeys: [entry.childSessionKey],
            onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
          });
        } catch (error) {
          params.warn("failed to cleanup browser sessions for completed subagent", {
            error: buildSafeLifecycleErrorMeta(error),
            runId: maskLifecycleIdentifier(completeParams.runId, "run"),
            childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
          });
        }
      }
    }
    if (dispatchedBrowserCleanup) {
      if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      refreshSessionEffectsSuppression();
      if (context.newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
    }
  }

  if (!suppressSessionEffects) {
    if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
    try {
      await retireRunModeBundleMcpRuntime(context, {
        runId: completeParams.runId,
        entry,
        reason: "subagent-run-complete",
      });
    } catch (error) {
      params.warn("failed to retire subagent bundle MCP runtime after completion", {
        error: buildSafeLifecycleErrorMeta(error),
        runId: maskLifecycleIdentifier(completeParams.runId, "run"),
        childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
      });
    }
    if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    refreshSessionEffectsSuppression();
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
  }

  if (isProvisionalKill) {
    // Browser and MCP resources can close immediately, but completion delivery
    // waits for the provider result or the killed tombstone reconciliation.
    return;
  }

  refreshSessionEffectsSuppression();
  context.startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
}
