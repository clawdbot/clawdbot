import type { SessionEntry } from "./types.js";

type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};

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

export function sqliteSessionSnapshotRowsEqual(
  left: Array<{ entry: SessionEntry; sessionKey: string }>,
  right: Array<{ entry: SessionEntry; sessionKey: string }>,
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

export function sqliteLifecycleTargetSnapshotsEqual(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
): boolean {
  return (
    expected.primary?.key === current.primary?.key &&
    sqliteSessionEntriesEqual(expected.primary?.entry, current.primary?.entry) &&
    sqliteSessionSnapshotRowsEqual(expected.rows, current.rows)
  );
}
