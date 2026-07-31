/** Read-only diagnostic readers used by the session SQLite doctor mode. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  migrateSessionFileEntryToCurrentVersion,
  normalizeLoadedFileEntry,
  partitionSessionFileEntries,
  type SessionFileEntryMigrationState,
} from "../agents/sessions/session-manager-codec.js";
import type { FileEntry } from "../agents/sessions/session-manager-types.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import type { SqliteTranscriptStorageRow } from "../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
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
const MAX_LEGACY_COMPACTION_TARGETS = 100_000;

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
  sessionId: string,
): (append: (event: TranscriptEvent) => void) => void {
  return (append) => {
    for (const event of readTranscriptEventsForImport(transcriptPath, sessionId, false)) {
      append(event as TranscriptEvent);
    }
  };
}

export function createTranscriptEventPrefixReader(
  transcriptPath: string,
  sessionId: string,
): (append: (event: TranscriptEvent) => void) => void {
  return (append) => {
    for (const event of readTranscriptEventsForImport(transcriptPath, sessionId, true)) {
      append(event as TranscriptEvent);
    }
  };
}

function readTranscriptEventsForImport(
  transcriptPath: string,
  sessionId: string,
  allowMalformedPrefix: boolean,
): Iterable<FileEntry> {
  // Production import owns the process-wide Gateway/SQLite-maintenance lock
  // through commit and archive. Fingerprints catch non-cooperating external edits.
  const sourceFingerprint = readTranscriptFileFingerprint(transcriptPath);
  const plan = planTranscriptImport(transcriptPath, allowMalformedPrefix);
  assertTranscriptFileUnchanged(transcriptPath, sourceFingerprint);
  const classificationHeader = {
    id: sessionId,
    type: "session",
    version: plan.sourceVersion,
  } as unknown as FileEntry;
  // V1 compactions refer to original row indexes. Stable index-derived IDs let
  // the second pass resolve those links without retaining the transcript.
  const idPrefix = createHash("sha256")
    .update(transcriptPath)
    .update("\0")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);

  return {
    *[Symbol.iterator]() {
      assertTranscriptFileUnchanged(transcriptPath, sourceFingerprint);
      const migratedTargetIds = new Map<number, string>();
      const migrationState: SessionFileEntryMigrationState = {
        createEntryId: (originalIndex) => `${idPrefix}-${originalIndex.toString(36)}`,
        previousId: null,
        resolveOriginalEntryId: (originalIndex) => migratedTargetIds.get(originalIndex),
        sourceVersion: plan.sourceVersion,
      };
      for (const { event: loadedEvent, originalIndex } of iterateTranscriptEvents(
        transcriptPath,
        allowMalformedPrefix,
      )) {
        let event = loadedEvent;
        let recognizedEvent: FileEntry | undefined;
        if (originalIndex === plan.headerIndex) {
          const legacyHeader = event as unknown as Record<string, unknown>;
          const canonicalHeader: Record<string, unknown> = {
            ...legacyHeader,
            id: sessionId,
            type: "session",
          };
          delete canonicalHeader.sessionId;
          event = canonicalHeader as unknown as FileEntry;
          recognizedEvent = event;
        } else {
          // Reuse the runtime partition contract one row at a time. The
          // synthetic header carries the source version without being emitted.
          recognizedEvent = partitionSessionFileEntries([classificationHeader, event])
            .fileEntriesByOriginalIndex[1];
        }

        if (recognizedEvent) {
          migrateSessionFileEntryToCurrentVersion(recognizedEvent, originalIndex, migrationState);
          if (
            recognizedEvent.type !== "session" &&
            plan.compactionTargetIndexes.has(originalIndex)
          ) {
            migratedTargetIds.set(originalIndex, recognizedEvent.id);
          }
          event = recognizedEvent;
        }
        yield event;
      }
      assertTranscriptFileUnchanged(transcriptPath, sourceFingerprint);
    },
  };
}

type TranscriptImportPlan = {
  compactionTargetIndexes: Set<number>;
  headerIndex: number;
  sourceVersion: number;
};

class TranscriptImportLimitError extends Error {}

type TranscriptFileFingerprint = {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
};

function readTranscriptFileFingerprint(transcriptPath: string): TranscriptFileFingerprint {
  const stat = fs.statSync(transcriptPath, { bigint: true });
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
}

function assertTranscriptFileUnchanged(
  transcriptPath: string,
  expected: TranscriptFileFingerprint,
): void {
  const current = readTranscriptFileFingerprint(transcriptPath);
  if (
    current.ctimeNs !== expected.ctimeNs ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mtimeNs !== expected.mtimeNs ||
    current.size !== expected.size
  ) {
    throw new Error(
      "Legacy transcript changed during import; stop active session writers and rerun `openclaw doctor --fix`.",
    );
  }
}

function planTranscriptImport(
  transcriptPath: string,
  allowMalformedPrefix: boolean,
): TranscriptImportPlan {
  const plan: TranscriptImportPlan = {
    compactionTargetIndexes: new Set(),
    headerIndex: -1,
    sourceVersion: 1,
  };
  for (const { event, originalIndex } of iterateTranscriptEvents(
    transcriptPath,
    allowMalformedPrefix,
  )) {
    if (plan.headerIndex < 0 && isRecord(event) && event.type === "session") {
      plan.headerIndex = originalIndex;
      plan.sourceVersion = typeof event.version === "number" ? event.version : 1;
    }
    if (
      isRecord(event) &&
      event.type === "compaction" &&
      Number.isInteger(event.firstKeptEntryIndex) &&
      Number(event.firstKeptEntryIndex) >= 0
    ) {
      const targetIndex = Number(event.firstKeptEntryIndex);
      if (
        !plan.compactionTargetIndexes.has(targetIndex) &&
        plan.compactionTargetIndexes.size >= MAX_LEGACY_COMPACTION_TARGETS
      ) {
        throw new TranscriptImportLimitError(
          `Transcript has more than ${MAX_LEGACY_COMPACTION_TARGETS} legacy compaction targets`,
        );
      }
      plan.compactionTargetIndexes.add(targetIndex);
    }
  }
  return plan;
}

function* iterateTranscriptEvents(
  transcriptPath: string,
  allowMalformedPrefix: boolean,
): Generator<{ event: FileEntry; originalIndex: number }> {
  let originalIndex = 0;
  try {
    for (const line of iterateJsonlLinesSync(transcriptPath)) {
      const parsed = parseJsonlLine(line);
      if (!parsed) {
        continue;
      }
      yield {
        event: normalizeLoadedFileEntry(parsed as FileEntry),
        originalIndex,
      };
      originalIndex += 1;
    }
  } catch (error) {
    if (!allowMalformedPrefix || error instanceof TranscriptImportLimitError) {
      throw error;
    }
    // The caller records the malformed transcript issue; keep the readable prefix.
  }
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
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
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
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
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
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
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
      ? (parsed as unknown as SessionEntry)
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

// Schema-tolerant session enumeration for transcript-label migration (avoids post-ship columns).
// Queries transcript_events table (schema-stable) instead of sessions table.
// Returns read-only view of all distinct session IDs with events.
export function readOnlySqliteTranscriptSessionIds(sqlitePath: string): string[] {
  if (!fs.existsSync(sqlitePath)) {
    return [];
  }
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("transcript_events");
    if (!table) {
      return [];
    }
    const rows = database
      .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id ASC")
      .all() as Array<{ session_id?: unknown }>;
    return rows
      .filter((row): row is { session_id: string } => typeof row.session_id === "string")
      .map((row) => row.session_id);
  } finally {
    database?.close();
  }
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

export function readOnlySqliteTranscriptSnapshot(
  sqlitePath: string,
  sessionId: string,
): ReadOnlyTranscriptSnapshot {
  if (!fs.existsSync(sqlitePath)) {
    return { ok: false, error: new Error(`SQLite database not found: ${sqlitePath}`) };
  }
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as Array<{ event_json?: string; seq?: number }>;
    const validRows = rows.filter(
      (row): row is { event_json: string; seq: number } =>
        typeof row.event_json === "string" && typeof row.seq === "number",
    );
    return {
      ok: true,
      rows: validRows.map((row) => ({ eventJson: row.event_json, seq: row.seq })),
    };
  } catch (error) {
    return { ok: false, error };
  } finally {
    database?.close();
  }
}

/** Reads exact row metadata for a guarded transcript replacement without opening a writer. */
export function readOnlySqliteTranscriptStorageSnapshot(
  sqlitePath: string,
  sessionId: string,
):
  | { ok: true; rows: SqliteTranscriptStorageRow[]; sessionKey?: string }
  | { ok: false; error: unknown } {
  if (!fs.existsSync(sqlitePath)) {
    return { ok: false, error: new Error(`SQLite database not found: ${sqlitePath}`) };
  }
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT created_at, event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as Array<{
      created_at?: unknown;
      event_json?: unknown;
      seq?: unknown;
    }>;
    const sessionKeyRow = database
      .prepare("SELECT session_key FROM session_windows WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { session_key?: unknown } | undefined;
    const storageRows: SqliteTranscriptStorageRow[] = [];
    for (const row of rows) {
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
  } finally {
    database?.close();
  }
}
