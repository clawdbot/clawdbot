/** Read-only transcript detection; positive repairs retain exact snapshots. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteTranscriptStorageRow } from "../config/sessions/session-accessor.sqlite-read.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

// Schema-tolerant session enumeration for transcript-label migration (avoids post-ship columns).
// Queries transcript_events table (schema-stable) instead of sessions table.
// Returns read-only view of all distinct session IDs with events.
export function readOnlySqliteTranscriptSessionIds(database: DatabaseSync): string[] {
  if (!tableExists(database, "transcript_events")) {
    return [];
  }
  const rows = database
    .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id ASC")
    .all();
  return rows.flatMap((row) => (typeof row.session_id === "string" ? [row.session_id] : []));
}

function iterateTranscriptRows(database: DatabaseSync, sessionId: string, firstRowOnly = false) {
  return database
    .prepare(
      `SELECT created_at, event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC${firstRowOnly ? " LIMIT 1" : ""}`,
    )
    .iterate(sessionId);
}

// Read-only transcript snapshot reader for dry-run detection phase.
// Avoids opening writable database lifecycle (lease/WAL/schema-ensure).
// Returns rows only; migration parses per-row during repair.
type ReadOnlyTranscriptSnapshot =
  | {
      ok: true;
      rows: Array<{ eventJson: string; seq: number }>;
    }
  | { ok: false; error: unknown };

export function readOnlySqliteTranscriptRepairSnapshot(
  database: DatabaseSync,
  sessionId: string,
  needsRepair: (event: unknown) => boolean,
): ReadOnlyTranscriptSnapshot {
  try {
    // Unchanged histories retain one payload. Re-read positive candidates in full so
    // malformed siblings and exact-snapshot guards still govern the surgical repair.
    for (const row of iterateTranscriptRows(database, sessionId)) {
      if (typeof row.event_json !== "string" || typeof row.seq !== "number") {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(row.event_json);
      } catch {
        continue;
      }
      if (!needsRepair(event)) {
        continue;
      }
      const rows: Array<{ eventJson: string; seq: number }> = [];
      for (const candidate of iterateTranscriptRows(database, sessionId)) {
        if (typeof candidate.event_json === "string" && typeof candidate.seq === "number") {
          rows.push({ eventJson: candidate.event_json, seq: candidate.seq });
        }
      }
      return { ok: true, rows };
    }
    return { ok: true, rows: [] };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Reads exact row metadata for a guarded transcript replacement without opening a writer. */
export function readOnlySqliteHeaderlessTranscriptSnapshot(
  database: DatabaseSync,
  sessionId: string,
):
  | { ok: true; rows: SqliteTranscriptStorageRow[]; sessionKey?: string }
  | { ok: false; error: unknown } {
  try {
    // Headers can live at nonzero seq. A current header needs no whole-history read;
    // possible headerless repairs still take and validate the complete exact snapshot.
    for (const row of iterateTranscriptRows(database, sessionId, true)) {
      if (typeof row.event_json !== "string") {
        break;
      }
      let first: unknown;
      try {
        first = JSON.parse(row.event_json);
      } catch {
        return { ok: true, rows: [] };
      }
      if (!isRecord(first) || first.type === "session") {
        return { ok: true, rows: [] };
      }
    }
    const sessionKeyRow = database
      .prepare("SELECT session_key FROM session_windows WHERE session_id = ? LIMIT 1")
      .get(sessionId);
    const storageRows: SqliteTranscriptStorageRow[] = [];
    for (const row of iterateTranscriptRows(database, sessionId)) {
      if (
        typeof row.created_at !== "number" ||
        typeof row.event_json !== "string" ||
        typeof row.seq !== "number"
      ) {
        return {
          ok: false,
          error: new Error(`Invalid transcript row metadata for session ${sessionId}`),
        };
      }
      storageRows.push({
        createdAt: row.created_at,
        eventJson: row.event_json,
        seq: row.seq,
      });
    }
    return {
      ok: true,
      rows: storageRows,
      ...(typeof sessionKeyRow?.session_key === "string"
        ? { sessionKey: sessionKeyRow.session_key }
        : {}),
    };
  } catch (error) {
    return { ok: false, error };
  }
}
