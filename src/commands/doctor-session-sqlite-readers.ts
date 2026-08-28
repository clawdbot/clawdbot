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
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import { resolveAllAgentSessionStoreCandidateTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

export type ReadOnlySqliteValidationSnapshot = {
  sessionIdsBySessionKey: ReadonlyMap<string, string>;
  transcriptEventCountsBySessionId: ReadonlyMap<string, number>;
};

type ReadOnlySqliteResult<T> = { ok: true; value: T } | { error: unknown; ok: false };
type ReadOnlySqliteValidationSnapshotResult =
  | { ok: true; snapshot: ReadOnlySqliteValidationSnapshot }
  | { error: unknown; ok: false };
type SessionIdentityRow = { session_id: string; session_key: string };
type ActiveTranscriptRow = SessionIdentityRow & { session_file?: string | null };

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
  allowMalformedPrefix = false,
  sourceFingerprint = readTranscriptFingerprint(transcriptPath),
): (append: (event: TranscriptEvent) => void) => () => void {
  return (append) => {
    for (const event of readTranscriptEventsForImport(
      transcriptPath,
      sessionId,
      allowMalformedPrefix,
      sourceFingerprint,
    )) {
      append(event as TranscriptEvent);
    }
    return () => assertTranscriptFileUnchanged(transcriptPath, sourceFingerprint);
  };
}

function readTranscriptEventsForImport(
  transcriptPath: string,
  sessionId: string,
  allowMalformedPrefix: boolean,
  sourceFingerprint: TranscriptFileFingerprint,
): Iterable<FileEntry> {
  // Production import owns the process-wide Gateway/SQLite-maintenance lock
  // through commit and archive. Fingerprints catch non-cooperating external edits.
  const plan = planTranscriptImport(transcriptPath, allowMalformedPrefix);
  assertTranscriptFileUnchanged(transcriptPath, sourceFingerprint);
  const classificationHeader = {
    id: sessionId,
    type: "session",
    version: plan.sourceVersion,
    timestamp: "",
    cwd: "",
  } satisfies FileEntry;
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
          const canonicalHeader = {
            ...event,
            id: sessionId,
            type: "session" as const,
            timestamp: typeof event.timestamp === "string" ? event.timestamp : "",
            cwd: "cwd" in event && typeof event.cwd === "string" ? event.cwd : "",
          };
          Reflect.deleteProperty(canonicalHeader, "sessionId");
          event = canonicalHeader;
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

export function readTranscriptFingerprint(transcriptPath: string): TranscriptFileFingerprint {
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
  const current = readTranscriptFingerprint(transcriptPath);
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
  const result = readSessionDatabase(target, (database) => {
    const projection = resolveSessionIdentityProjection(database);
    const raw = projection
      ? database.prepare(`SELECT count(*) AS count FROM ${projection.source}`).get()
      : undefined;
    const row = isRecord(raw) ? raw : undefined;
    return sqliteNumber(row?.count);
  });
  return result.ok ? (result.value ?? 0) : 0;
}

export function readOnlySqliteValidationSnapshot(
  target: SessionStoreTarget,
): ReadOnlySqliteValidationSnapshotResult {
  const empty: ReadOnlySqliteValidationSnapshot = {
    sessionIdsBySessionKey: new Map(),
    transcriptEventCountsBySessionId: new Map(),
  };
  const result = readSessionDatabase(target, (database) => {
    const projection = resolveSessionIdentityProjection(database);
    const sessionIdsBySessionKey = new Map<string, string>();
    if (projection) {
      const statement = database.prepare(
        `SELECT session_key, ${projection.sessionIdColumn} AS session_id
               FROM ${projection.source}
              ORDER BY session_key`,
      );
      // SAFETY: the selected SQLite columns have stable TEXT identities.
      for (const row of statement.iterate() as Iterable<SessionIdentityRow>) {
        sessionIdsBySessionKey.set(row.session_key, row.session_id);
      }
    }
    const transcriptEventCountsBySessionId = new Map<string, number>();
    if (tableExists(database, "transcript_events")) {
      const statement = database.prepare(
        "SELECT session_id, COUNT(*) AS count FROM transcript_events GROUP BY session_id ORDER BY session_id",
      );
      for (const row of statement.iterate()) {
        if (typeof row.session_id === "string" && typeof row.count === "number") {
          transcriptEventCountsBySessionId.set(row.session_id, row.count);
        }
      }
    }
    return {
      sessionIdsBySessionKey,
      transcriptEventCountsBySessionId,
    };
  });
  return result.ok ? { ok: true, snapshot: result.value ?? empty } : result;
}

export function scanReadOnlySqliteActiveTranscriptFiles(
  target: SessionStoreTarget,
  visit: (sessionKey: string, sessionId: string, sessionFile?: string) => void,
): { ok: true } | { error: unknown; ok: false } {
  const result = readSessionDatabase(target, (database) => {
    const projection = resolveSessionIdentityProjection(database);
    if (!projection) {
      return;
    }
    const statement = database.prepare(
      `SELECT session_key, ${projection.sessionIdColumn} AS session_id,
                CASE WHEN json_valid(entry_json)
                  THEN json_extract(entry_json, '$.sessionFile') END AS session_file
           FROM ${projection.source}
          ORDER BY session_key`,
    );
    // SAFETY: the query returns typed identities plus an optional JSON string.
    const rows = statement.iterate() as Iterable<ActiveTranscriptRow>;
    for (const row of rows) {
      visit(row.session_key, row.session_id, row.session_file ?? undefined);
    }
  });
  return result.ok ? { ok: true } : result;
}

function readSessionDatabase<T>(
  target: SessionStoreTarget,
  read: (database: DatabaseSync) => T,
): ReadOnlySqliteResult<T | undefined> {
  const sqlitePath = resolveTargetSqlitePath(target);
  if (!fs.existsSync(sqlitePath)) {
    return { ok: true, value: undefined };
  }
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
    return { ok: true, value: read(database) };
  } catch (error) {
    return { error, ok: false };
  } finally {
    database?.close();
  }
}

function resolveSessionIdentityProjection(database: DatabaseSync) {
  if (tableExists(database, "session_nodes")) {
    return {
      sessionIdColumn: "current_session_id",
      source: `session_nodes WHERE ${tableHasColumn(database, "session_nodes", "entry_valid") ? "entry_valid = 1" : "entry_json <> '{}'"}`,
    };
  }
  return tableExists(database, "session_entries")
    ? { sessionIdColumn: "session_id", source: "session_entries" }
    : undefined;
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
    const hasTranscriptEvents = tableExists(database, "transcript_events");
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

export function resolveTargetSqliteOptions(target: SessionStoreTarget, env?: NodeJS.ProcessEnv) {
  return toDatabaseOptions(
    resolveSqliteReadScope({
      agentId: target.agentId,
      env,
      storePath: target.sqlitePath ?? target.storePath,
    }),
  );
}

export function resolveTargetSqlitePath(
  target: SessionStoreTarget,
  env?: NodeJS.ProcessEnv,
): string {
  return resolveOpenClawAgentSqlitePath(resolveTargetSqliteOptions(target, env));
}

/**
 * Enumerates existing per-agent session SQLite databases for a Doctor repair.
 * Deduplicates by resolved path (aliases collapse to one target) and skips
 * databases that do not yet exist on disk. Shared by every session-row repair
 * so target enumeration cannot drift between repair surfaces.
 */
export function listExistingAgentDatabaseTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Array<{ agentId: string; sqlitePath: string; storePath: string }> {
  const seenPaths = new Set<string>();
  return resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env }).flatMap((target) => {
    const sqlitePath = resolveTargetSqlitePath(target, env);
    if (seenPaths.has(sqlitePath) || !fs.existsSync(sqlitePath)) {
      return [];
    }
    seenPaths.add(sqlitePath);
    return [{ agentId: target.agentId, sqlitePath, storePath: target.storePath }];
  });
}

function* iterateJsonlLinesSync(filePath: string): Generator<{ lineNumber: number; text: string }> {
  const fd = fs.openSync(filePath, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
  let fragments: string[] = [];
  let lineNumber = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const parts = decoder.decode(buffer.subarray(0, bytesRead), { stream: true }).split("\n");
      for (let index = 0; index < parts.length - 1; index++) {
        fragments.push(parts[index]!);
        lineNumber += 1;
        const text = fragments.join("").trim();
        fragments = [];
        if (text) {
          yield { lineNumber, text };
        }
      }
      fragments.push(parts.at(-1)!);
    }
    fragments.push(decoder.decode());
    const text = fragments.join("").trim();
    if (text) {
      yield { lineNumber: lineNumber + 1, text };
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

function parseJsonlLine(line: { text: string }): unknown {
  return JSON.parse(line.text);
}
