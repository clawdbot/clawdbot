import type { SessionEntry } from "../config/sessions.js";

export function isSubagentRecoveryWedgedEntry(entry: unknown): boolean {
  const recovery =
    entry && typeof entry === "object" ? (entry as SessionEntry).subagentRecovery : undefined;
  return (
    typeof recovery?.wedgedAt === "number" &&
    Number.isFinite(recovery.wedgedAt) &&
    recovery.wedgedAt > 0
  );
}

export function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string {
  return (
    entry.subagentRecovery?.wedgedReason?.trim() ||
    "subagent orphan recovery is tombstoned for this session"
  );
}

export function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
