import type { SessionEntry } from "../config/sessions.js";

// Automatic orphan recovery is intentionally bounded. Repeated quick resumes
// mark the session wedged so maintenance/doctor can reconcile durable state.
const SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;
const SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS = 2 * 60_000;

/** Decision returned before attempting automatic subagent orphan recovery. */
type SubagentRecoveryGate =
  | {
      allowed: true;
      nextAttempt: number;
    }
  | {
      allowed: false;
      reason: string;
      shouldMarkWedged: boolean;
    };

// Attempts outside the rewedge window start a new small burst instead of
// permanently consuming the session's automatic recovery budget.
function isRecentRecoveryAttempt(entry: SessionEntry, now: number): boolean {
  const lastAttemptAt = entry.subagentRecovery?.lastAttemptAt;
  return (
    typeof lastAttemptAt === "number" &&
    Number.isFinite(lastAttemptAt) &&
    now - lastAttemptAt <= SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS
  );
}

/** Returns true when recovery has been tombstoned for a session entry. */
export function isSubagentRecoveryWedgedEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const recovery = (entry as SessionEntry).subagentRecovery;
  return (
    typeof recovery?.wedgedAt === "number" &&
    Number.isFinite(recovery.wedgedAt) &&
    recovery.wedgedAt > 0
  );
}

/** Formats the operator-facing reason for a wedged recovery entry. */
export function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string {
  return (
    entry.subagentRecovery?.wedgedReason?.trim() ||
    "subagent orphan recovery is tombstoned for this session"
  );
}

/** Checks whether automatic orphan recovery may run for this session entry. */
export function evaluateSubagentRecoveryGate(
  entry: SessionEntry,
  now: number,
): SubagentRecoveryGate {
  if (isSubagentRecoveryWedgedEntry(entry)) {
    return {
      allowed: false,
      reason: formatSubagentRecoveryWedgedReason(entry),
      shouldMarkWedged: false,
    };
  }

  const previousAttempts = isRecentRecoveryAttempt(entry, now)
    ? Math.max(0, entry.subagentRecovery?.automaticAttempts ?? 0)
    : 0;
  if (previousAttempts >= SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS) {
    return {
      allowed: false,
      reason:
        `subagent orphan recovery blocked after ${previousAttempts} rapid accepted resume attempts; ` +
        `run "openclaw tasks maintenance --apply" or "openclaw doctor --fix" to reconcile it`,
      shouldMarkWedged: true,
    };
  }

  return {
    allowed: true,
    nextAttempt: previousAttempts + 1,
  };
}

/** Records one accepted automatic orphan-recovery attempt. */
export function markSubagentRecoveryAttempt(params: {
  entry: SessionEntry;
  now: number;
  runId: string;
  attempt: number;
}): void {
  params.entry.subagentRecovery = {
    automaticAttempts: Math.max(1, params.attempt),
    lastAttemptAt: params.now,
    lastRunId: params.runId,
  };
}

/** Tombstones automatic recovery until maintenance or doctor clears the state. */
export function markSubagentRecoveryWedged(params: {
  entry: SessionEntry;
  now: number;
  runId?: string;
  reason: string;
}): void {
  params.entry.abortedLastRun = false;
  params.entry.subagentRecovery = {
    ...params.entry.subagentRecovery,
    automaticAttempts: Math.max(
      params.entry.subagentRecovery?.automaticAttempts ?? 0,
      SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS,
    ),
    lastAttemptAt: params.entry.subagentRecovery?.lastAttemptAt ?? params.now,
    ...(params.runId ? { lastRunId: params.runId } : {}),
    wedgedAt: params.now,
    wedgedReason: params.reason,
  };
  params.entry.updatedAt = params.now;
}

/** Clears stale abort state when a wedged entry should no longer look runnable. */
export function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
