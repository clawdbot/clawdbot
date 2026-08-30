/** Read-only transcript detection; positive repairs retain exact snapshots. */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteTranscriptStorageRow } from "../config/sessions/session-accessor.sqlite-read.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

const LABEL_ROWS_SQL =
  "SELECT event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC";

type ReadOnlyTranscriptSnapshot =
  | {
      ok: true;
      rows: Array<{ eventJson: string; seq: number }>;
    }
  | { ok: false; error: unknown };

export class ReadOnlySqliteTranscriptReader {
  private labelDetection?: StatementSync;
  private labelSnapshot?: StatementSync;
  private firstHeaderRow?: StatementSync;
  private headerSnapshot?: StatementSync;
  private sessionKey?: StatementSync;

  // Statements belong to one read-only pass, but no cursor survives a snapshot call.
  // Prepare lazily so older databases need only the schema used by that detection path.
  constructor(private readonly database: DatabaseSync) {}

  sessionIds(): string[] {
    if (!tableExists(this.database, "transcript_events")) {
      return [];
    }
    // Enumerate the schema-stable events table, not post-ship sessions columns.
    // Materialize IDs so enumeration cannot hold a read transaction across repairs.
    const rows = this.database
      .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id ASC")
      .all();
    return rows.flatMap((row) => (typeof row.session_id === "string" ? [row.session_id] : []));
  }

  repairSnapshot(
    sessionId: string,
    needsRepair: (event: unknown) => boolean,
  ): ReadOnlyTranscriptSnapshot {
    let iterator: ReturnType<StatementSync["iterate"]> | undefined;
    try {
      // Unchanged histories retain one payload. Re-read positive candidates in full so
      // malformed siblings and exact-snapshot guards still govern the surgical repair.
      this.labelDetection ??= this.database.prepare(LABEL_ROWS_SQL);
      iterator = this.labelDetection.iterate(sessionId);
      for (const row of iterator) {
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
        // Detection is still iterating: its nested exact snapshot needs a distinct statement.
        this.labelSnapshot ??= this.database.prepare(LABEL_ROWS_SQL);
        iterator = this.labelSnapshot.iterate(sessionId);
        for (const candidate of iterator) {
          if (typeof candidate.event_json === "string" && typeof candidate.seq === "number") {
            rows.push({ eventJson: candidate.event_json, seq: candidate.seq });
          }
        }
        return { ok: true, rows };
      }
      return { ok: true, rows: [] };
    } catch (error) {
      // A throwing next() does not close its iterator; reset before the next session.
      try {
        iterator?.return?.();
      } catch {
        // Preserve the original read error if cleanup fails.
      }
      return { ok: false, error };
    }
  }

  /** Reads exact row metadata for a guarded transcript replacement without opening a writer. */
  headerlessSnapshot(
    sessionId: string,
  ):
    | { ok: true; rows: SqliteTranscriptStorageRow[]; sessionKey?: string }
    | { ok: false; error: unknown } {
    let iterator: ReturnType<StatementSync["iterate"]> | undefined;
    try {
      // Headers can live at nonzero seq. A current header needs no whole-history read;
      // possible headerless repairs still take and validate the complete exact snapshot.
      this.firstHeaderRow ??= this.database.prepare(
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC LIMIT 1",
      );
      const firstRow = this.firstHeaderRow.get(sessionId);
      if (typeof firstRow?.event_json === "string") {
        let first: unknown;
        try {
          first = JSON.parse(firstRow.event_json);
        } catch {
          return { ok: true, rows: [] };
        }
        if (!isRecord(first) || first.type === "session") {
          return { ok: true, rows: [] };
        }
      }
      this.sessionKey ??= this.database.prepare(
        "SELECT session_key FROM session_windows WHERE session_id = ? LIMIT 1",
      );
      const sessionKeyRow = this.sessionKey.get(sessionId);
      const storageRows: SqliteTranscriptStorageRow[] = [];
      this.headerSnapshot ??= this.database.prepare(
        "SELECT created_at, event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC",
      );
      iterator = this.headerSnapshot.iterate(sessionId);
      for (const row of iterator) {
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
      // A throwing next() does not close its iterator; reset before the next session.
      try {
        iterator?.return?.();
      } catch {
        // Preserve the original read error if cleanup fails.
      }
      return { ok: false, error };
    }
  }
}
