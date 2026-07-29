/**
 * Session-store maintenance protection for subagent runs.
 * Preserves child session keys while runs are active, pending delivery, or
 * awaiting completion announces so pruning cannot delete needed transcripts.
 */
import { registerSessionMaintenancePreserveKeysProvider } from "../config/sessions/store-maintenance-preserve.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function isCleanupCompleteForMaintenance(entry: SubagentRunRecord): boolean {
  return typeof entry.cleanupCompletedAt === "number";
}

function isActiveForMaintenance(entry: SubagentRunRecord): boolean {
  return typeof entry.endedAt !== "number";
}

function isPendingFinalDeliveryForMaintenance(entry: SubagentRunRecord): boolean {
  return entry.delivery?.status === "pending" || isDeliverySuspended(entry);
}

function isAwaitingCompletionAnnounceForMaintenance(entry: SubagentRunRecord): boolean {
  return entry.expectsCompletionMessage === true && entry.delivery?.status !== "delivered";
}

function shouldPreserveForMaintenance(entry: SubagentRunRecord): boolean {
  if (entry.killReconciliation) {
    // The killed row is a reconciliation tombstone. Its session owns the
    // provider result until the sweeper accepts completion or finalizes cancellation.
    return true;
  }
  if (isCleanupCompleteForMaintenance(entry)) {
    return false;
  }
  if (isActiveForMaintenance(entry)) {
    return true;
  }
  return (
    isAwaitingCompletionAnnounceForMaintenance(entry) || isPendingFinalDeliveryForMaintenance(entry)
  );
}

/** Lists child session keys protected from session-store maintenance pruning. */
function listSessionMaintenanceProtectedSubagentSessionKeys(): string[] {
  const keys = new Set<string>();
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (!shouldPreserveForMaintenance(entry)) {
      continue;
    }
    const childSessionKey = entry.childSessionKey.trim();
    if (childSessionKey) {
      keys.add(childSessionKey);
    }
  }
  return [...keys];
}

registerSessionMaintenancePreserveKeysProvider(listSessionMaintenanceProtectedSubagentSessionKeys);
