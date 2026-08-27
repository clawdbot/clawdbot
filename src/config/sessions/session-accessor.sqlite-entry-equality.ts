import type { SessionEntry } from "./types.js";

export type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};

type SqliteSessionEntrySelectionSnapshot = {
  selected: { entry: SessionEntry; row: { session_key: string } } | undefined;
  selectedRows: Array<{ entry: SessionEntry; sessionKey: string }>;
};

type SessionEntryComparator = (
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
) => boolean;

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

export function sqliteLifecycleSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const { owner: _leftOwner, ...leftEntry } = left;
  const { owner: _rightOwner, ...rightEntry } = right;
  // Owner is stored in dedicated columns and same-session lifecycle/reply
  // writes preserve that projection instead of replacing it.
  return sqliteSessionEntriesEqual(leftEntry, rightEntry);
}

function sqliteSessionSnapshotRowsEqual(
  left: Array<{ entry: SessionEntry; sessionKey: string }>,
  right: Array<{ entry: SessionEntry; sessionKey: string }>,
  entriesEqual: SessionEntryComparator = sqliteSessionEntriesEqual,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey && entriesEqual(row.entry, right[index]?.entry),
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

export function assertSessionEntrySelectionUnchanged(
  expected: SqliteSessionEntrySelectionSnapshot,
  current: SqliteSessionEntrySelectionSnapshot,
  operationLabel: string,
  preserveOwnerProjection = false,
): void {
  const entriesEqual = preserveOwnerProjection
    ? sqliteLifecycleSessionEntriesEqual
    : sqliteSessionEntriesEqual;
  const selectedMatches =
    expected.selected?.row.session_key === current.selected?.row.session_key &&
    entriesEqual(expected.selected?.entry, current.selected?.entry);
  if (
    !selectedMatches ||
    !sqliteSessionSnapshotRowsEqual(expected.selectedRows, current.selectedRows, entriesEqual)
  ) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
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
