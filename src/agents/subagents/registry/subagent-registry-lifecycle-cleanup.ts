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
import {
  markPendingFinalDelivery,
  safeMarkRequiredCompletionDeliveryBlocked,
  safeSetSubagentTaskDeliveryStatus,
} from "./subagent-registry-lifecycle-delivery.js";
import {
  markRequesterSettleWakePending,
  scheduleRequesterSettleWake,
} from "./subagent-registry-lifecycle-wake.js";
import type {
  SubagentLifecycleCommonContext,
  SubagentLifecycleCompletionContext,
  SubagentLifecycleCleanupContext,
  SubagentLifecycleOptions,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const MAX_DETACHED_CLEANUP_RETRIES = 3;

function isCleanupGenerationCurrent(
  context: SubagentLifecycleCleanupContext,
  params: SubagentLifecycleOptions,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): boolean {
  return (
    params.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    context.isCleanupGeneration(entry, generation) &&
    !context.newerGenerationOwnsSession(entry)
  );
}

export function scheduleResumeSubagentRun(
  context: SubagentLifecycleCleanupContext,
  params: SubagentLifecycleOptions,
  runId: string,
  entry: SubagentRunRecord,
  delayMs: number,
  cleanupGeneration?: number,
): void {
  const timer = setTimeout(() => {
    context.deleteScheduledResumeTimer(timer);
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (params.runs.get(runId) !== entry) {
        return;
      }
      if (cleanupGeneration !== undefined) {
        if (!isCleanupGenerationCurrent(context, params, runId, entry, cleanupGeneration)) {
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
          params,
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

export function isCleanupAttemptCurrent(
  context: SubagentLifecycleCleanupContext,
  params: SubagentLifecycleOptions,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): boolean {
  return (
    entry.cleanupHandled === true &&
    isCleanupGenerationCurrent(context, params, runId, entry, generation)
  );
}

export function runDetachedCleanupAttempt(
  context: SubagentLifecycleCleanupContext,
  params: SubagentLifecycleOptions,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanupGeneration: number;
    run: () => Promise<void>;
  },
): void {
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
          !isCleanupAttemptCurrent(context, params, args.runId, args.entry, args.cleanupGeneration)
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
            params,
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
          params,
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
  params: SubagentLifecycleOptions,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
    error?: string;
  },
): void {
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
  safeSetSubagentTaskDeliveryStatus(params, context, {
    entry: args.entry,
    deliveryStatus: "failed",
    deliveryError: getDeliveryLastError(args.entry) ?? args.reason,
  });
  safeMarkRequiredCompletionDeliveryBlocked(params, context, {
    entry: args.entry,
    reason: getDeliveryLastError(args.entry) ?? args.reason,
  });
  logAnnounceGiveUp(args.entry, args.reason);
  markRequesterSettleWakePending(args.entry);
  try {
    params.persistOrThrow(args.runId);
  } catch (error) {
    const mutableEntry = args.entry as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutableEntry)) {
      delete mutableEntry[key];
    }
    Object.assign(args.entry, previousEntry);
    throw error;
  }
  // Suspension is terminal for automatic retries, so it settles this child
  // for requester-drain purposes even though cleanup stays incomplete.
  scheduleRequesterSettleWake(context, params, args.runId, args.entry);
}

export function beginSubagentCleanup(
  context: SubagentLifecycleCleanupContext,
  params: SubagentLifecycleOptions,
  runId: string,
): boolean {
  const entry = params.runs.get(runId);
  if (!entry || entry.cleanupCompletedAt || entry.cleanupHandled) {
    return false;
  }
  entry.cleanupHandled = true;
  context.bumpCleanupGeneration(entry);
  params.persist(runId);
  return true;
}

export async function retireSupersededCleanupIfNeeded(
  context: SubagentLifecycleCleanupContext,
  params: SubagentLifecycleOptions,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): Promise<boolean> {
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
  params: SubagentLifecycleOptions,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): void {
  // Delivery callbacks are synchronous and may arrive after their announce
  // attempt returns. Give the async retirement tail its own snapshot blocker.
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    await retireSupersededCleanupIfNeeded(context, params, runId, entry, generation);
  }).catch((error: unknown) => {
    defaultRuntime.log(
      `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
    );
  });
}

export function isTerminalCallbackCurrent(
  context: SubagentLifecycleCompletionContext,
  params: SubagentLifecycleOptions,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): boolean {
  return (
    params.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    context.isTerminalGeneration(entry, generation)
  );
}

export function isEndedHookOwnerCurrent(
  context: SubagentLifecycleCleanupContext,
  params: SubagentLifecycleOptions,
  runId: string,
  entry: SubagentRunRecord,
): boolean {
  const current = params.runs.get(runId);
  return (current === undefined || current === entry) && !context.newerGenerationOwnsSession(entry);
}

export async function retireRunModeBundleMcpRuntime(
  context: SubagentLifecycleCommonContext,
  params: SubagentLifecycleOptions,
  cleanupParams: { runId: string; entry: SubagentRunRecord; reason: string },
): Promise<void> {
  if (cleanupParams.entry.spawnMode === "session") {
    return;
  }
  await retireSessionMcpRuntimeForSessionKey({
    sessionKey: cleanupParams.entry.childSessionKey,
    reason: cleanupParams.reason,
    preserveActiveLeases: true,
    onError: (error, sessionId) => {
      params.warn("failed to retire subagent bundle MCP runtime", {
        error: context.buildSafeLifecycleErrorMeta(error),
        sessionId,
        runId: context.maskRunId(cleanupParams.runId),
        childSessionKey: context.maskSessionKey(cleanupParams.entry.childSessionKey),
      });
    },
  });
}

export async function completeTerminalEffects(
  context: SubagentLifecycleCompletionContext,
  params: SubagentLifecycleOptions,
  args: {
    completeParams: SubagentCompletionRequest;
    completionReason: SubagentLifecycleEndedReason;
    entry: SubagentRunRecord;
    mutated: boolean;
    sessionSuperseded: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
      typeof cleanupBrowserSessionsForLifecycleEnd
    >;
  },
): Promise<void> {
  const { completeParams, completionReason, entry, mutated, terminalGeneration } = args;
  let { sessionSuperseded, suppressSessionEffects } = args;
  const isCurrentTerminalCallback = () =>
    isTerminalCallbackCurrent(context, params, completeParams.runId, entry, terminalGeneration);
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
  await completeTerminalCleanup(context, params, {
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

export async function completeTerminalCleanup(
  context: SubagentLifecycleCompletionContext,
  params: SubagentLifecycleOptions,
  args: {
    completeParams: SubagentCompletionRequest;
    entry: SubagentRunRecord;
    isProvisionalKill: boolean;
    retireSupersededSession: (entry: SubagentRunRecord) => Promise<void>;
    suppressedForSteerRestart: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
      typeof cleanupBrowserSessionsForLifecycleEnd
    >;
  },
): Promise<void> {
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
    isTerminalCallbackCurrent(context, params, completeParams.runId, entry, terminalGeneration) &&
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
  if (
    !isTerminalCallbackCurrent(context, params, completeParams.runId, entry, terminalGeneration)
  ) {
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
        error: context.buildSafeLifecycleErrorMeta(error),
        runId: context.maskRunId(completeParams.runId),
        childSessionKey: context.maskSessionKey(entry.childSessionKey),
      });
    }
    if (cleanupBrowserSessions) {
      if (
        !isTerminalCallbackCurrent(context, params, completeParams.runId, entry, terminalGeneration)
      ) {
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
            error: context.buildSafeLifecycleErrorMeta(error),
            runId: context.maskRunId(completeParams.runId),
            childSessionKey: context.maskSessionKey(entry.childSessionKey),
          });
        }
      }
    }
    if (dispatchedBrowserCleanup) {
      if (
        !isTerminalCallbackCurrent(context, params, completeParams.runId, entry, terminalGeneration)
      ) {
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
    if (
      !isTerminalCallbackCurrent(context, params, completeParams.runId, entry, terminalGeneration)
    ) {
      return;
    }
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
    try {
      await retireRunModeBundleMcpRuntime(context, params, {
        runId: completeParams.runId,
        entry,
        reason: "subagent-run-complete",
      });
    } catch (error) {
      params.warn("failed to retire subagent bundle MCP runtime after completion", {
        error: context.buildSafeLifecycleErrorMeta(error),
        runId: context.maskRunId(completeParams.runId),
        childSessionKey: context.maskSessionKey(entry.childSessionKey),
      });
    }
    if (
      !isTerminalCallbackCurrent(context, params, completeParams.runId, entry, terminalGeneration)
    ) {
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
