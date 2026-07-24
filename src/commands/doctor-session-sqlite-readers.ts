/** Read-only diagnostic readers used by the session SQLite doctor mode. */
import fs from "node:fs";
import { TextDecoder } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLoadedFileEntry, type FileEntry } from "../agents/sessions/session-manager.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { requireNodeSqlite, resolveNodeSqliteLocation } from "../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";

type ReadOnlySqliteSessionSummary = {
  entry: SessionEntry;
  sessionKey: string;
};

type ReadOnlySqliteSessionEntriesResult =
  | { exists: false; ok: true; summaries: [] }
  | { exists: true; ok: true; summaries: ReadOnlySqliteSessionSummary[] }
  | { error: unknown; exists: true; ok: false };

type ReadOnlySqliteExactSessionEntryResult =
  | { entry?: ReadOnlySqliteSessionSummary; ok: true }
  | { error: unknown; ok: false };

type ReadOnlySqliteTranscriptEventCountResult =
  | { events: number; exists: boolean; ok: true }
  | { error: unknown; exists: true; ok: false };

type ReadOnlySqliteDbStatsResult =
  | {
      ok: true;
      stats: {
        dbSizeBytes: number;
        integrityCheck?: string;
        largestSessions: Array<{ events: number; rowBytes: number; sessionId: string }>;
        totalTranscriptRowBytes: number;
        walSizeBytes: number;
      };
    }
  | { error: unknown; ok: false };

type TranscriptEventCountResult =
  | { status: "ok"; events: number }
  | { status: "missing" }
  | { status: "malformed"; message: string };

const JSONL_READ_CHUNK_BYTES = 64 * 1024;

export function countTranscriptEventsForPath(
  transcriptPath: string | undefined,
): TranscriptEventCountResult {
  if (!transcriptPath) {
    return { status: "ok", events: 0 };
  }
  if (!fs.existsSync(transcriptPath)) {
    return { status: "missing" };
  }
  let events = 0;
  try {
    for (const line of iterateJsonlLinesSync(transcriptPath)) {
      if (!parseJsonlLine(line)) {
        continue;
      }
      events += 1;
    }
    return { status: "ok", events };
  } catch (err) {
    return { status: "malformed", message: String(err) };
  }
}

export function createTranscriptEventReader(
  transcriptPath: string,
): (append: (event: TranscriptEvent) => void) => void {
  return (append) => {
    for (const line of iterateJsonlLinesSync(transcriptPath)) {
      const parsed = parseJsonlLine(line);
      if (parsed) {
        // Import is the migration boundary: repair legacy JSONL message shapes
        // here because the SQLite runtime read path assumes canonical rows.
        append(normalizeLoadedFileEntry(parsed as FileEntry) as TranscriptEvent);
      }
    }
  };
}

export function createTranscriptEventPrefixReader(
  transcriptPath: string,
): (append: (event: TranscriptEvent) => void) => void {
  return (append) => {
    try {
      for (const line of iterateJsonlLinesSync(transcriptPath)) {
        const parsed = parseJsonlLine(line);
        if (parsed) {
          append(normalizeLoadedFileEntry(parsed as FileEntry) as TranscriptEvent);
        }
      }
    } catch {
      // The caller records the malformed transcript issue; keep the readable prefix.
    }
  };
}

export function readSqliteEntryCount(target: SessionStoreTarget): number {
  const result = readOnlySqliteSessionEntries(target);
  return result.ok ? result.summaries.length : 0;
}

export function readOnlySqliteExactSessionEntry(
  target: SessionStoreTarget,
  sessionKey: string,
): ReadOnlySqliteExactSessionEntryResult {
  const result = readOnlySqliteSessionEntries(target);
  if (!result.ok) {
    return { error: result.error, ok: false };
  }
  return {
    entry: result.summaries.find((summary) => summary.sessionKey === sessionKey),
    ok: true,
  };
}

export function readOnlySqliteSessionEntries(
  target: SessionStoreTarget,
): ReadOnlySqliteSessionEntriesResult {
  const sqlitePath = resolveTargetSqlitePath(target);
  if (!fs.existsSync(sqlitePath)) {
    return { exists: false, ok: true, summaries: [] };
  }
  const sqlite = requireNodeSqlite();
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    database = new sqlite.DatabaseSync(resolveNodeSqliteLocation(sqlitePath), {
      readOnly: true,
    });
    const nodeTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("session_nodes");
    const legacyEntryTable = nodeTable
      ? undefined
      : database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("session_entries");
    if (!nodeTable && !legacyEntryTable) {
      return { exists: true, ok: true, summaries: [] };
    }
    const rows = database
      .prepare(
        nodeTable
          ? "SELECT session_key, entry_json FROM session_nodes ORDER BY session_key ASC"
          : "SELECT session_key, entry_json FROM session_entries ORDER BY session_key ASC",
      )
      .all() as Array<{ entry_json?: unknown; session_key?: unknown }>;
    return {
      exists: true,
      ok: true,
      summaries: rows.flatMap((row) => {
        if (typeof row.session_key !== "string" || typeof row.entry_json !== "string") {
          return [];
        }
        const entry = parseSqliteSessionEntry(row.entry_json);
        return entry ? [{ entry, sessionKey: row.session_key }] : [];
      }),
    };
  } catch (error) {
    return { error, exists: true, ok: false };
  } finally {
    database?.close();
  }
}

export function readOnlySqliteTranscriptEventCount(
  target: SessionStoreTarget,
  sessionId: string,
): ReadOnlySqliteTranscriptEventCountResult {
  const sqlitePath = resolveTargetSqlitePath(target);
  if (!fs.existsSync(sqlitePath)) {
    return { events: 0, exists: false, ok: true };
  }
  const sqlite = requireNodeSqlite();
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    database = new sqlite.DatabaseSync(resolveNodeSqliteLocation(sqlitePath), {
      readOnly: true,
    });
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("transcript_events");
    if (!table) {
      return { events: 0, exists: true, ok: true };
    }
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
      .get(sessionId) as { count?: unknown } | undefined;
    const count = row?.count;
    return {
      events: typeof count === "number" && Number.isFinite(count) ? count : 0,
      exists: true,
      ok: true,
    };
  } catch (error) {
    return { error, exists: true, ok: false };
  } finally {
    database?.close();
  }
}

export function readOnlySqliteDbStats(target: SessionStoreTarget): ReadOnlySqliteDbStatsResult {
  const sqlitePath = resolveTargetSqlitePath(target);
  const sizeFor = (filePath: string): number => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  };
  if (!fs.existsSync(sqlitePath)) {
    return {
      ok: true,
      stats: {
        dbSizeBytes: 0,
        largestSessions: [],
        totalTranscriptRowBytes: 0,
        walSizeBytes: sizeFor(`${sqlitePath}-wal`),
      },
    };
  }
  const sqlite = requireNodeSqlite();
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    database = new sqlite.DatabaseSync(resolveNodeSqliteLocation(sqlitePath), {
      readOnly: true,
    });
    const hasTranscriptEvents = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("transcript_events");
    const integrityRow = database.prepare("PRAGMA quick_check").get() as
      | { quick_check?: unknown }
      | undefined;
    if (!hasTranscriptEvents) {
      return {
        ok: true,
        stats: {
          dbSizeBytes: sizeFor(sqlitePath),
          integrityCheck:
            typeof integrityRow?.quick_check === "string" ? integrityRow.quick_check : undefined,
          largestSessions: [],
          totalTranscriptRowBytes: 0,
          walSizeBytes: sizeFor(`${sqlitePath}-wal`),
        },
      };
    }
    const totalRow = database
      .prepare("SELECT COALESCE(SUM(LENGTH(event_json)), 0) AS row_bytes FROM transcript_events")
      .get() as { row_bytes?: unknown } | undefined;
    const largestRows = database
      .prepare(
        `
          SELECT session_id, COUNT(*) AS events, COALESCE(SUM(LENGTH(event_json)), 0) AS row_bytes
          FROM transcript_events
          GROUP BY session_id
          ORDER BY row_bytes DESC, events DESC, session_id ASC
          LIMIT 5
        `,
      )
      .all() as Array<{ events?: unknown; row_bytes?: unknown; session_id?: unknown }>;
    return {
      ok: true,
      stats: {
        dbSizeBytes: sizeFor(sqlitePath),
        integrityCheck:
          typeof integrityRow?.quick_check === "string" ? integrityRow.quick_check : undefined,
        largestSessions: largestRows.flatMap((row) => {
          if (typeof row.session_id !== "string") {
            return [];
          }
          return [
            {
              events: sqliteNumber(row.events),
              rowBytes: sqliteNumber(row.row_bytes),
              sessionId: row.session_id,
            },
          ];
        }),
        totalTranscriptRowBytes: sqliteNumber(totalRow?.row_bytes),
        walSizeBytes: sizeFor(`${sqlitePath}-wal`),
      },
    };
  } catch (error) {
    return { error, ok: false };
  } finally {
    database?.close();
  }
}

export function resolveTargetSqlitePath(target: SessionStoreTarget): string {
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
  });
  return resolveOpenClawAgentSqlitePath({
    agentId: sqliteTarget.agentId ?? target.agentId,
    ...(sqliteTarget.path ? { path: sqliteTarget.path } : {}),
  });
}

function parseSqliteSessionEntry(entryJson: string): SessionEntry | undefined {
  try {
    const parsed = JSON.parse(entryJson) as unknown;
    return isRecord(parsed) && typeof parsed.sessionId === "string"
      ? (parsed as SessionEntry)
      : undefined;
  } catch {
    return undefined;
  }
}

function* iterateJsonlLinesSync(
  filePath: string,
): Generator<{ final: boolean; lineNumber: number; text: string }> {
  const fd = fs.openSync(filePath, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
  let carry = "";
  let lineNumber = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const parts = carry.split(/\r?\n/);
      carry = parts.pop() ?? "";
      for (const part of parts) {
        lineNumber += 1;
        const text = part.trim();
        if (text) {
          yield { final: false, lineNumber, text };
        }
      }
    }
    carry += decoder.decode();
    const text = carry.trim();
    if (text) {
      yield { final: true, lineNumber: lineNumber + 1, text };
    }
  } catch (err) {
    throw new Error(`${filePath}:${lineNumber + 1}: ${String(err)}`, { cause: err });
  } finally {
    fs.closeSync(fd);
  }
}

function sqliteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return 0;
}

function parseJsonlLine(line: { final: boolean; lineNumber: number; text: string }): unknown {
  try {
    return JSON.parse(line.text);
  } catch (error) {
    if (line.final) {
      return undefined;
    }
    throw error;
  }
}
