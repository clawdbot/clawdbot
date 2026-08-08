import { mergeSessionEntryBlobs } from "./session-entry-blobs.js";

export function hasValidSqliteSessionEntryIdentity(entry: {
  sessionId?: unknown;
  updatedAt?: unknown;
}): entry is { sessionId: string; updatedAt: number } {
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

export function parseSqliteSessionEntryRecord(row: {
  current_session_id?: string;
  entry_json: string;
  // When a reader selects the entry_blobs_json side column, the two large fields
  // are hydrated back; hot bulk list reads omit the column and stay small.
  entry_blobs_json?: string | null;
  updated_at?: number;
}): (Record<string, unknown> & { sessionId: string; updatedAt: number }) | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (!hasValidSqliteSessionEntryIdentity(record)) {
      return null;
    }
    if (
      (row.current_session_id !== undefined && row.current_session_id !== record.sessionId) ||
      (row.updated_at !== undefined && row.updated_at !== record.updatedAt)
    ) {
      return null;
    }
    mergeSessionEntryBlobs(record, row.entry_blobs_json);
    return record;
  } catch {
    return null;
  }
}
