import { registerSessionMaintenancePreserveKeysProvider } from "../config/sessions/store-maintenance-preserve.js";
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
  return entry.pendingFinalDelivery === true;
}

function isAwaitingCompletionAnnounceForMaintenance(entry: SubagentRunRecord): boolean {
  return entry.expectsCompletionMessage === true && typeof entry.completionAnnouncedAt !== "number";
}

function shouldPreserveForMaintenance(entry: SubagentRunRecord): boolean {
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

export function listSessionMaintenanceProtectedSubagentSessionKeys(): string[] {
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
