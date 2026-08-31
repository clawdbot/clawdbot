import type { SessionEntry } from "./types.js";

export type SqliteLifecycleTargetSnapshot = Array<{ entry: SessionEntry; sessionKey: string }>;

class SqliteSessionMutationConflictError extends Error {
  constructor(operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

export function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const {
    participants: _leftParticipants,
    participantCount: _leftParticipantCount,
    ...leftEntry
  } = left;
  const {
    participants: _rightParticipants,
    participantCount: _rightParticipantCount,
    ...rightEntry
  } = right;
  // Participant history is a separately mutable SQLite projection. It must not
  // invalidate logical-session compare-and-swap or leak into entry_json writes.
  return JSON.stringify(leftEntry) === JSON.stringify(rightEntry);
}

export function sqliteLifecycleTargetSnapshotsEqual(
  left: SqliteLifecycleTargetSnapshot,
  right: SqliteLifecycleTargetSnapshot,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey &&
        sqliteSessionEntriesEqual(row.entry, right[index]?.entry),
    )
  );
}

export function assertLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  if (!sqliteLifecycleTargetSnapshotsEqual(expected, current)) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}
