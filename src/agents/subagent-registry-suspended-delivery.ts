import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const CRON_EXPIRY_MS = 2 * 60 * 60_000;
const SUBAGENT_EXPIRY_MS = 6 * 60 * 60_000;
const INTERACTIVE_EXPIRY_MS = 24 * 60 * 60_000;

export function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
  return typeof entry.execution.endedAt === "number" && isDeliverySuspended(entry);
}

export function resolveSuspendedDeliveryExpiryMs(entry: SubagentRunRecord): number {
  const requester = entry.requesterSessionKey;
  return requester.includes(":cron:")
    ? CRON_EXPIRY_MS
    : requester.includes(":subagent:")
      ? SUBAGENT_EXPIRY_MS
      : INTERACTIVE_EXPIRY_MS;
}

export async function discardSuspendedPendingFinalDelivery(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  reason: "expired" | "pressure-pruned";
  resumedRuns: Set<string>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  completeCleanupBookkeeping: (params: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
    skipRequesterSettleWake: true;
  }) => void;
  shouldEmitEndedHookForRun: (params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }) => boolean;
  emitSubagentEndedHookForRun: (params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
    sendFarewell: true;
  }) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  const { runId, entry, now, reason, resumedRuns } = params;
  const snapshot = structuredClone(entry);
  const wasResumed = resumedRuns.has(runId);
  const delivery = ensureDeliveryState(entry);
  const payload = delivery.payload;
  delivery.status = "discarded";
  delivery.discardedAt = now;
  delivery.discardReason = reason;
  delivery.discardedPayloadSummary = {
    requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
    childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
    childRunId: payload?.childRunId ?? entry.runId,
    endedAt: payload?.endedAt ?? entry.execution.endedAt,
    status: payload?.outcome?.status ?? entry.execution.outcome?.status,
    lastError: getDeliveryLastError(entry) ?? null,
  };
  delivery.payload = undefined;
  delivery.createdAt = undefined;
  delivery.lastAttemptAt = undefined;
  delivery.attemptCount = undefined;
  delivery.lastError = undefined;
  delivery.suspendedAt = undefined;
  delivery.suspendedReason = undefined;
  entry.wakeOnDescendantSettle = undefined;
  const completion = ensureCompletionState(entry);
  completion.fallbackResultText = undefined;
  completion.fallbackCapturedAt = undefined;
  entry.cleanupHandled = true;
  delivery.announcedAt = undefined;
  const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
  const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  try {
    params.completeCleanupBookkeeping({
      runId,
      entry,
      cleanup: entry.cleanup,
      completedAt: now,
      skipRequesterSettleWake: true,
    });
  } catch (error) {
    const mutableEntry = entry as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutableEntry)) {
      delete mutableEntry[key];
    }
    Object.assign(entry, snapshot);
    if (wasResumed) {
      resumedRuns.add(runId);
    }
    throw error;
  }
  resumedRuns.delete(runId);
  params.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  params.warn("subagent suspended delivery discarded", {
    reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
  });
  if (entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry);
  }
  if (
    !suppressSessionEffects &&
    entry.expectsCompletionMessage === true &&
    params.shouldEmitEndedHookForRun({ entry, reason: completionReason })
  ) {
    await params.emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: true,
    });
  }
}
