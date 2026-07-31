import type {
  SubagentCompletionDeliveryState,
  SubagentCompletionState,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export function normalizeSubagentRunState(entry: SubagentRunRecord): SubagentRunRecord {
  const taskRunId = typeof entry.taskRunId === "string" ? entry.taskRunId.trim() : "";
  entry.taskRunId = taskRunId || undefined;
  const requesterTurnRunId =
    typeof entry.requesterTurnRunId === "string" ? entry.requesterTurnRunId.trim() : "";
  entry.requesterTurnRunId = requesterTurnRunId || undefined;
  entry.requesterTurnYielded =
    requesterTurnRunId && entry.requesterTurnYielded === true ? true : undefined;
  entry.retireAfterRequesterTurn =
    requesterTurnRunId && entry.retireAfterRequesterTurn === true ? true : undefined;
  entry.generation =
    typeof entry.generation === "number" &&
    Number.isSafeInteger(entry.generation) &&
    entry.generation > 0
      ? entry.generation
      : undefined;
  entry.deleteCleanupDispatchedAt = Number.isFinite(entry.deleteCleanupDispatchedAt)
    ? entry.deleteCleanupDispatchedAt
    : undefined;
  entry.suppressCompletionDelivery = entry.suppressCompletionDelivery === true ? true : undefined;
  entry.terminalOwner =
    entry.terminalOwner === "interrupted-recovery" &&
    Number.isFinite(entry.endedAt) &&
    entry.outcome?.status === "error" &&
    entry.endedReason === "subagent-error" &&
    entry.pauseReason !== "sessions_yield"
      ? "interrupted-recovery"
      : undefined;
  const killReconciliation = entry.killReconciliation;
  if (
    !killReconciliation ||
    typeof killReconciliation !== "object" ||
    !Number.isFinite(killReconciliation.killedAt)
  ) {
    delete entry.killReconciliation;
  } else {
    entry.killReconciliation = {
      killedAt: killReconciliation.killedAt,
      suppressTaskDelivery: killReconciliation.suppressTaskDelivery === true ? true : undefined,
      supersededAt: Number.isFinite(killReconciliation.supersededAt)
        ? killReconciliation.supersededAt
        : undefined,
    };
  }
  // cleanupHandled is an in-process lock; after restart, unfinished cleanup must
  // retry unless durable cleanup completion was recorded.
  if (
    entry.cleanupHandled === true &&
    typeof entry.cleanupCompletedAt !== "number" &&
    entry.delivery?.status !== "discarded"
  ) {
    entry.cleanupHandled = false;
  }
  return entry;
}

/** Ensures a run has a nested completion state object. */
export function ensureCompletionState(entry: SubagentRunRecord): SubagentCompletionState {
  entry.completion ??= {
    required: entry.expectsCompletionMessage === true,
  };
  return entry.completion;
}

/** Ensures a run has a nested delivery state object. */
export function ensureDeliveryState(entry: SubagentRunRecord): SubagentCompletionDeliveryState {
  entry.delivery ??= {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
  return entry.delivery;
}

/** Resets delivery state to its initial status for the run's completion requirement. */
export function clearDeliveryState(entry: SubagentRunRecord): void {
  entry.delivery = {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
}

/** Returns true when delivery is suspended with a durable timestamp. */
export function isDeliverySuspended(entry: Pick<SubagentRunRecord, "delivery">): boolean {
  return entry.delivery?.status === "suspended" && typeof entry.delivery.suspendedAt === "number";
}

/** Reads the current delivery attempt count. */
export function getDeliveryAttemptCount(entry: SubagentRunRecord): number {
  return entry.delivery?.attemptCount ?? 0;
}

/** Reads the timestamp of the last delivery attempt. */
export function getDeliveryLastAttemptAt(entry: SubagentRunRecord): number | undefined {
  return entry.delivery?.lastAttemptAt;
}

/** Reads the non-empty last delivery error. */
export function getDeliveryLastError(entry: SubagentRunRecord): string | undefined {
  const error = entry.delivery?.lastError;
  return typeof error === "string" && error.trim() ? error : undefined;
}
