import { isDeliverySuspended } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT = 25;
export const SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP = 50;

export function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
  return typeof entry.execution.endedAt === "number" && isDeliverySuspended(entry);
}

export function resolveSuspendedDeliveryExpiryMs(): number {
  return SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS;
}

export async function discardSuspendedPendingFinalDelivery(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  reason: "expired";
  resumedRuns: Set<string>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
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
  params.discardTerminalDelivery(entry, now, reason);
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
