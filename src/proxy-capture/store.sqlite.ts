// Proxy capture SQLite store persists capture metadata and replayable exchanges.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { gunzipSync, gzipSync } from "node:zlib";
import { normalizeNullableString as normalizeObservedValue } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { sha256Hex } from "../infra/crypto-digest.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  configureSqliteConnectionPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type {
  CaptureBlobRecord,
  CaptureEventRecord,
  CaptureObservedDimension,
  CaptureQueryPreset,
  CaptureQueryRow,
  CaptureSessionCoverageSummary,
  CaptureSessionRecord,
  CaptureSessionSummary,
  SharedCaptureBlobRecord,
} from "./types.js";

// Capture rows and compressed payload BLOBs live in the shared global state DB.
type DebugProxyCaptureStoreOptions = {
  env?: NodeJS.ProcessEnv;
};

type PathBasedDebugProxyCaptureStore = {
  blobDir: string;
  walMaintenance: SqliteWalMaintenance;
};

const DEBUG_PROXY_CAPTURE_DIR_MODE = 0o700;
const DEBUG_PROXY_CAPTURE_FILE_MODE = 0o600;

function isInMemoryDatabasePath(dbPath: string): boolean {
  if (dbPath === ":memory:") {
    return true;
  }
  if (!dbPath.startsWith("file:")) {
    return false;
  }
  const fragmentIndex = dbPath.indexOf("#");
  const uriWithoutFragment = fragmentIndex === -1 ? dbPath : dbPath.slice(0, fragmentIndex);
  const queryIndex = uriWithoutFragment.indexOf("?");
  const uriPath = queryIndex === -1 ? uriWithoutFragment : uriWithoutFragment.slice(0, queryIndex);
  try {
    if (decodeURIComponent(uriPath.slice("file:".length)) === ":memory:") {
      return true;
    }
  } catch {
    // Malformed escapes cannot identify a memory URI; retain file-backed handling.
  }
  return (
    queryIndex !== -1 &&
    new URLSearchParams(uriWithoutFragment.slice(queryIndex + 1)).get("mode") === "memory"
  );
}

function hardenLegacyDatabaseFiles(dbPath: string): void {
  for (const candidate of resolveSqliteDatabaseFilePaths(dbPath)) {
    if (fs.existsSync(candidate)) {
      applyPrivateModeSync(candidate, DEBUG_PROXY_CAPTURE_FILE_MODE);
    }
  }
}

function openPathBasedDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): { db: DatabaseSync; pathBased: PathBasedDebugProxyCaptureStore } {
  const fileBackedPath = isInMemoryDatabasePath(dbPath) ? undefined : dbPath;
  if (fileBackedPath) {
    fs.mkdirSync(path.dirname(fileBackedPath), {
      recursive: true,
      mode: DEBUG_PROXY_CAPTURE_DIR_MODE,
    });
    if (!fs.existsSync(fileBackedPath)) {
      fs.closeSync(fs.openSync(fileBackedPath, "a", DEBUG_PROXY_CAPTURE_FILE_MODE));
    }
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    if (fileBackedPath) {
      applyPrivateModeSync(fileBackedPath, DEBUG_PROXY_CAPTURE_FILE_MODE);
    }
    walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 5000,
      databaseLabel: "debug-proxy-capture-sdk",
      ...(fileBackedPath ? { databasePath: fileBackedPath } : {}),
      foreignKeys: true,
    });
    db.exec(`
      CREATE TABLE IF NOT EXISTS capture_sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        mode TEXT NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        proxy_url TEXT,
        db_path TEXT NOT NULL,
        blob_dir TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capture_events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        protocol TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        method TEXT,
        host TEXT,
        path TEXT,
        status INTEGER,
        close_code INTEGER,
        content_type TEXT,
        headers_json TEXT,
        data_text TEXT,
        data_blob_id TEXT,
        data_sha256 TEXT,
        error_text TEXT,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS capture_events_session_ts_idx ON capture_events(session_id, ts);
      CREATE INDEX IF NOT EXISTS capture_events_flow_idx ON capture_events(flow_id, ts);
    `);
    if (fileBackedPath) {
      hardenLegacyDatabaseFiles(fileBackedPath);
    }
    return {
      db,
      pathBased: {
        blobDir,
        walMaintenance,
      },
    };
  } catch (err) {
    walMaintenance?.close();
    db.close();
    throw err;
  }
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

// Metadata is optional and user/tool supplied, so parse defensively for coverage
// summaries instead of assuming every event has valid JSON.
function parseMetaJson(metaJson: unknown): Record<string, unknown> | null {
  if (typeof metaJson !== "string" || metaJson.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sortObservedCounts(counts: Map<string, number>): CaptureObservedDimension[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

class DebugProxyCaptureStoreImpl {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly blobDir: string;
  private readonly pathBased?: PathBasedDebugProxyCaptureStore;
  private closed = false;

  constructor(
    optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
    legacyBlobDir?: string,
  ) {
    if (typeof optionsOrDbPath === "string") {
      if (!legacyBlobDir) {
        throw new TypeError("legacy debug proxy capture store requires a blob directory");
      }
      const opened = openPathBasedDebugProxyCaptureStore(optionsOrDbPath, legacyBlobDir);
      this.db = opened.db;
      this.dbPath = optionsOrDbPath;
      this.blobDir = legacyBlobDir;
      this.pathBased = opened.pathBased;
      return;
    }
    const database = openOpenClawStateDatabase({ env: optionsOrDbPath.env });
    this.db = database.db;
    this.dbPath = database.path;
    // Retain the shipped public property while shared-state blobs live in this DB.
    this.blobDir = database.path;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    if (this.pathBased) {
      this.pathBased.walMaintenance.close();
      this.db.close();
    }
    this.closed = true;
  }

  get isClosed(): boolean {
    // A store dies with the DatabaseSync it wraps: the shared-path handle can
    // be closed underneath us (exit-time cache close), and the cache must then
    // rebind a fresh store instead of handing out a dead connection.
    return this.closed || !this.db.isOpen;
  }

  upsertSession(session: CaptureSessionRecord): void {
    if (this.pathBased) {
      this.db
        .prepare(
          `INSERT INTO capture_sessions (
            id, started_at, ended_at, mode, source_scope, source_process, proxy_url, db_path, blob_dir
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            ended_at=excluded.ended_at,
            proxy_url=excluded.proxy_url,
            source_process=excluded.source_process`,
        )
        .run(
          session.id,
          session.startedAt,
          session.endedAt ?? null,
          session.mode,
          session.sourceScope,
          session.sourceProcess,
          session.proxyUrl ?? null,
          session.dbPath ?? this.dbPath,
          session.blobDir ?? this.pathBased.blobDir,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO capture_sessions (
          id, started_at, ended_at, mode, source_scope, source_process, proxy_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          started_at=MIN(capture_sessions.started_at, excluded.started_at),
          ended_at=excluded.ended_at,
          mode=CASE
            WHEN capture_sessions.mode = 'implicit' THEN excluded.mode
            ELSE capture_sessions.mode
          END,
          proxy_url=excluded.proxy_url,
          source_process=excluded.source_process`,
      )
      .run(
        session.id,
        session.startedAt,
        session.endedAt ?? null,
        session.mode,
        session.sourceScope,
        session.sourceProcess,
        session.proxyUrl ?? null,
      );
  }

  endSession(sessionId: string, endedAt = Date.now()): void {
    this.db
      .prepare(`UPDATE capture_sessions SET ended_at = ? WHERE id = ?`)
      .run(endedAt, sessionId);
  }

  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord | SharedCaptureBlobRecord {
    const sha256 = sha256Hex(data);
    const blobId = sha256.slice(0, 24);
    if (this.pathBased) {
      fs.mkdirSync(this.pathBased.blobDir, {
        recursive: true,
        mode: DEBUG_PROXY_CAPTURE_DIR_MODE,
      });
      const outputPath = path.join(this.pathBased.blobDir, `${blobId}.bin.gz`);
      if (!fs.existsSync(outputPath)) {
        fs.writeFileSync(outputPath, gzipSync(data), {
          mode: DEBUG_PROXY_CAPTURE_FILE_MODE,
        });
      }
      applyPrivateModeSync(outputPath, DEBUG_PROXY_CAPTURE_FILE_MODE);
      return {
        blobId,
        path: outputPath,
        encoding: "gzip",
        sizeBytes: data.byteLength,
        sha256,
        ...(contentType ? { contentType } : {}),
      };
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO capture_blobs (
          blob_id, content_type, encoding, size_bytes, sha256, data, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        blobId,
        contentType ?? null,
        "gzip",
        data.byteLength,
        sha256,
        gzipSync(data),
        Date.now(),
      );
    return {
      blobId,
      encoding: "gzip",
      sizeBytes: data.byteLength,
      sha256,
      ...(contentType ? { contentType } : {}),
    };
  }

  recordEvent(event: CaptureEventRecord): void {
    if (this.pathBased) {
      this.insertEvent(event, event.dataBlobId ?? null);
      return;
    }
    runSqliteImmediateTransactionSync(this.db, () => {
      // Capture can be invoked directly by provider seams before the top-level
      // runtime initializes. Keep the shared-schema foreign key valid without
      // making diagnostics break the request they are observing.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO capture_sessions (
            id, started_at, mode, source_scope, source_process
          ) VALUES (?, ?, 'implicit', ?, ?)`,
        )
        .run(event.sessionId, event.ts, event.sourceScope, event.sourceProcess);
      // A concurrent purge can remove a payload before its event is recorded.
      // Keep the inline preview instead of failing the observed request.
      const dataBlobId =
        event.dataBlobId &&
        this.db.prepare(`SELECT 1 FROM capture_blobs WHERE blob_id = ?`).get(event.dataBlobId)
          ? event.dataBlobId
          : null;
      this.insertEvent(event, dataBlobId);
    });
  }

  private insertEvent(event: CaptureEventRecord, dataBlobId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO capture_events (
          session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
          method, host, path, status, close_code, content_type, headers_json,
          data_text, data_blob_id, data_sha256, error_text, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionId,
        event.ts,
        event.sourceScope,
        event.sourceProcess,
        event.protocol,
        event.direction,
        event.kind,
        event.flowId,
        event.method ?? null,
        event.host ?? null,
        event.path ?? null,
        event.status ?? null,
        event.closeCode ?? null,
        event.contentType ?? null,
        event.headersJson ?? null,
        event.dataText ?? null,
        dataBlobId,
        event.dataSha256 ?? null,
        event.errorText ?? null,
        event.metaJson ?? null,
      );
  }

  listSessions(limit = 50): CaptureSessionSummary[] {
    return this.db
      .prepare(
        `SELECT
           s.id,
           s.started_at AS startedAt,
           s.ended_at AS endedAt,
           s.mode,
           s.source_process AS sourceProcess,
           s.proxy_url AS proxyUrl,
           COUNT(e.id) AS eventCount
         FROM capture_sessions s
         LEFT JOIN capture_events e ON e.session_id = s.id
         GROUP BY s.id
         ORDER BY s.started_at DESC
         LIMIT ?`,
      )
      .all(limit) as CaptureSessionSummary[];
  }

  getSessionEvents(sessionId: string, limit = 500): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT
           id, session_id AS sessionId, ts, source_scope AS sourceScope, source_process AS sourceProcess,
           protocol, direction, kind, flow_id AS flowId, method, host, path, status, close_code AS closeCode,
           content_type AS contentType, headers_json AS headersJson, data_text AS dataText,
           data_blob_id AS dataBlobId, data_sha256 AS dataSha256, error_text AS errorText, meta_json AS metaJson
         FROM capture_events
         WHERE session_id = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
  }

  summarizeSessionCoverage(sessionId: string): CaptureSessionCoverageSummary {
    const rows = this.db
      .prepare(
        `SELECT host, meta_json AS metaJson
         FROM capture_events
         WHERE session_id = ?`,
      )
      .all(sessionId) as Array<{ host?: string | null; metaJson?: string | null }>;
    const providers = new Map<string, number>();
    const apis = new Map<string, number>();
    const models = new Map<string, number>();
    const hosts = new Map<string, number>();
    const localPeers = new Map<string, number>();
    let unlabeledEventCount = 0;
    for (const row of rows) {
      const meta = parseMetaJson(row.metaJson);
      const provider = normalizeObservedValue(meta?.provider);
      const api = normalizeObservedValue(meta?.api);
      const model = normalizeObservedValue(meta?.model);
      const host = normalizeObservedValue(row.host);
      if (!provider && !api && !model) {
        unlabeledEventCount += 1;
      }
      if (provider) {
        providers.set(provider, (providers.get(provider) ?? 0) + 1);
      }
      if (api) {
        apis.set(api, (apis.get(api) ?? 0) + 1);
      }
      if (model) {
        models.set(model, (models.get(model) ?? 0) + 1);
      }
      if (host) {
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
        // Local model/provider endpoints are useful to surface separately when
        // debugging why cloud-provider labels are absent.
        if (
          host === "127.0.0.1:11434" ||
          host.startsWith("127.0.0.1:") ||
          host.startsWith("localhost:")
        ) {
          localPeers.set(host, (localPeers.get(host) ?? 0) + 1);
        }
      }
    }
    return {
      sessionId,
      totalEvents: rows.length,
      unlabeledEventCount,
      providers: sortObservedCounts(providers),
      apis: sortObservedCounts(apis),
      models: sortObservedCounts(models),
      hosts: sortObservedCounts(hosts),
      localPeers: sortObservedCounts(localPeers),
    };
  }

  readBlob(blobId: string): string | null {
    if (this.pathBased) {
      const legacyRow = this.db
        .prepare(`SELECT data_blob_id AS blobId FROM capture_events WHERE data_blob_id = ? LIMIT 1`)
        .get(blobId) as { blobId?: string } | undefined;
      if (!legacyRow?.blobId) {
        return null;
      }
      const blobPath = path.join(this.pathBased.blobDir, `${legacyRow.blobId}.bin.gz`);
      return fs.existsSync(blobPath)
        ? gunzipSync(fs.readFileSync(blobPath)).toString("utf8")
        : null;
    }
    const row = this.db
      .prepare(`SELECT encoding, data FROM capture_blobs WHERE blob_id = ?`)
      .get(blobId) as { data?: Uint8Array; encoding?: string } | undefined;
    if (row?.data) {
      const data = Buffer.from(row.data);
      return (row.encoding === "gzip" ? gunzipSync(data) : data).toString("utf8");
    }
    return null;
  }

  queryPreset(preset: CaptureQueryPreset, sessionId?: string): CaptureQueryRow[] {
    const sessionWhere = sessionId ? "AND session_id = ?" : "";
    const args = sessionId ? [sessionId] : [];
    switch (preset) {
      // Presets are intentionally SQL-only summaries so the CLI can query large
      // capture sessions without loading every event into memory.
      case "double-sends":
        return this.db
          .prepare(
            `SELECT host, path, method, COUNT(*) AS duplicateCount
             FROM capture_events
             WHERE kind = 'request' ${sessionWhere}
             GROUP BY host, path, method, data_sha256
             HAVING COUNT(*) > 1
             ORDER BY duplicateCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "retry-storms":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS errorCount
             FROM capture_events
             WHERE kind = 'response' AND status >= 429 ${sessionWhere}
             GROUP BY host, path
             HAVING COUNT(*) > 1
             ORDER BY errorCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "cache-busting":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS variantCount
             FROM capture_events
             WHERE kind = 'request'
               AND (path LIKE '%?%' OR headers_json LIKE '%cache-control%' OR headers_json LIKE '%pragma%')
               ${sessionWhere}
             GROUP BY host, path
             ORDER BY variantCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "ws-duplicate-frames":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS duplicateFrames
             FROM capture_events
             WHERE kind = 'ws-frame' AND direction = 'outbound' ${sessionWhere}
             GROUP BY host, path, data_sha256
             HAVING COUNT(*) > 1
             ORDER BY duplicateFrames DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "missing-ack":
        return this.db
          .prepare(
            `SELECT flow_id AS flowId, host, path, COUNT(*) AS outboundFrames
             FROM capture_events
             WHERE kind = 'ws-frame' AND direction = 'outbound' ${sessionWhere}
               AND flow_id NOT IN (
                 SELECT flow_id FROM capture_events
                 WHERE kind = 'ws-frame' AND direction = 'inbound' ${sessionId ? "AND session_id = ?" : ""}
               )
             GROUP BY flow_id, host, path
             ORDER BY outboundFrames DESC`,
          )
          .all(...(sessionId ? [sessionId, sessionId] : [])) as CaptureQueryRow[];
      case "error-bursts":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS errorCount
             FROM capture_events
             WHERE kind = 'error' ${sessionWhere}
             GROUP BY host, path
             ORDER BY errorCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      default:
        return [];
    }
  }

  purgeAll(): { sessions: number; events: number; blobs: number } {
    if (this.pathBased) {
      const sessionCount =
        (
          this.db.prepare(`SELECT COUNT(*) AS count FROM capture_sessions`).get() as {
            count: number;
          }
        ).count ?? 0;
      const eventCount =
        (this.db.prepare(`SELECT COUNT(*) AS count FROM capture_events`).get() as { count: number })
          .count ?? 0;
      this.db.exec(`DELETE FROM capture_events; DELETE FROM capture_sessions;`);
      let blobs = 0;
      if (fs.existsSync(this.pathBased.blobDir)) {
        for (const entry of fs.readdirSync(this.pathBased.blobDir)) {
          fs.rmSync(path.join(this.pathBased.blobDir, entry), { force: true });
          blobs += 1;
        }
      }
      return { sessions: sessionCount, events: eventCount, blobs };
    }
    return runSqliteImmediateTransactionSync(this.db, () => {
      const sessionCount =
        (
          this.db.prepare(`SELECT COUNT(*) AS count FROM capture_sessions`).get() as {
            count: number;
          }
        ).count ?? 0;
      const eventCount =
        (this.db.prepare(`SELECT COUNT(*) AS count FROM capture_events`).get() as { count: number })
          .count ?? 0;
      const blobCount =
        (this.db.prepare(`SELECT COUNT(*) AS count FROM capture_blobs`).get() as { count: number })
          .count ?? 0;
      this.db.exec(
        `DELETE FROM capture_events; DELETE FROM capture_sessions; DELETE FROM capture_blobs;`,
      );
      return { sessions: sessionCount, events: eventCount, blobs: blobCount };
    });
  }

  deleteSessions(sessionIds: string[]): { sessions: number; events: number; blobs: number } {
    const uniqueSessionIds = normalizeUniqueStringEntries(sessionIds);
    if (uniqueSessionIds.length === 0) {
      return { sessions: 0, events: 0, blobs: 0 };
    }
    if (this.pathBased) {
      return this.deletePathBasedSessions(uniqueSessionIds);
    }
    return runSqliteImmediateTransactionSync(this.db, () => {
      const placeholders = uniqueSessionIds.map(() => "?").join(", ");
      const blobRows = this.db
        .prepare(
          `SELECT DISTINCT data_blob_id AS blobId
           FROM capture_events
           WHERE session_id IN (${placeholders})
             AND data_blob_id IS NOT NULL`,
        )
        .all(...uniqueSessionIds) as Array<{ blobId?: string | null }>;
      const eventCount =
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM capture_events
               WHERE session_id IN (${placeholders})`,
            )
            .get(...uniqueSessionIds) as { count: number }
        ).count ?? 0;
      const sessionCount =
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM capture_sessions
               WHERE id IN (${placeholders})`,
            )
            .get(...uniqueSessionIds) as { count: number }
        ).count ?? 0;
      this.db
        .prepare(`DELETE FROM capture_events WHERE session_id IN (${placeholders})`)
        .run(...uniqueSessionIds);
      this.db
        .prepare(`DELETE FROM capture_sessions WHERE id IN (${placeholders})`)
        .run(...uniqueSessionIds);
      const candidateBlobIds = blobRows
        .map((row) => row.blobId?.trim())
        .filter((blobId): blobId is string => Boolean(blobId));
      const remainingBlobRefs =
        // Shared blobs are deleted only when no surviving event references them.
        candidateBlobIds.length > 0
          ? new Set(
              (
                this.db
                  .prepare(
                    `SELECT DISTINCT data_blob_id AS blobId
                     FROM capture_events
                     WHERE data_blob_id IN (${candidateBlobIds.map(() => "?").join(", ")})
                       AND data_blob_id IS NOT NULL`,
                  )
                  .all(...candidateBlobIds) as Array<{ blobId?: string | null }>
              )
                .map((row) => row.blobId?.trim())
                .filter((blobId): blobId is string => Boolean(blobId)),
            )
          : new Set<string>();
      let blobs = 0;
      const deleteBlob = this.db.prepare(`DELETE FROM capture_blobs WHERE blob_id = ?`);
      for (const blobId of candidateBlobIds) {
        if (remainingBlobRefs.has(blobId)) {
          continue;
        }
        const result = deleteBlob.run(blobId);
        if (Number(result.changes) > 0) {
          blobs += 1;
        }
      }
      return { sessions: sessionCount, events: eventCount, blobs };
    });
  }

  private deletePathBasedSessions(sessionIds: string[]): {
    sessions: number;
    events: number;
    blobs: number;
  } {
    const pathBased = this.pathBased;
    if (!pathBased) {
      throw new Error("path-based debug proxy capture store is unavailable");
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    const blobRows = this.db
      .prepare(
        `SELECT DISTINCT data_blob_id AS blobId
         FROM capture_events
         WHERE session_id IN (${placeholders})
           AND data_blob_id IS NOT NULL`,
      )
      .all(...sessionIds) as Array<{ blobId?: string | null }>;
    const eventCount =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM capture_events
             WHERE session_id IN (${placeholders})`,
          )
          .get(...sessionIds) as { count: number }
      ).count ?? 0;
    const sessionCount =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM capture_sessions
             WHERE id IN (${placeholders})`,
          )
          .get(...sessionIds) as { count: number }
      ).count ?? 0;
    this.db
      .prepare(`DELETE FROM capture_events WHERE session_id IN (${placeholders})`)
      .run(...sessionIds);
    this.db
      .prepare(`DELETE FROM capture_sessions WHERE id IN (${placeholders})`)
      .run(...sessionIds);
    const candidateBlobIds = blobRows
      .map((row) => row.blobId?.trim())
      .filter((blobId): blobId is string => Boolean(blobId));
    const remainingBlobRefs =
      candidateBlobIds.length > 0
        ? new Set(
            (
              this.db
                .prepare(
                  `SELECT DISTINCT data_blob_id AS blobId
                   FROM capture_events
                   WHERE data_blob_id IN (${candidateBlobIds.map(() => "?").join(", ")})
                     AND data_blob_id IS NOT NULL`,
                )
                .all(...candidateBlobIds) as Array<{ blobId?: string | null }>
            )
              .map((row) => row.blobId?.trim())
              .filter((blobId): blobId is string => Boolean(blobId)),
          )
        : new Set<string>();
    let blobs = 0;
    for (const blobId of candidateBlobIds) {
      if (remainingBlobRefs.has(blobId)) {
        continue;
      }
      const blobPath = path.join(pathBased.blobDir, `${blobId}.bin.gz`);
      if (fs.existsSync(blobPath)) {
        fs.rmSync(blobPath, { force: true });
        blobs += 1;
      }
    }
    return { sessions: sessionCount, events: eventCount, blobs };
  }
}

export type DebugProxyCaptureStore = Omit<DebugProxyCaptureStoreImpl, "persistPayload"> & {
  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord | SharedCaptureBlobRecord;
};

type LegacyDebugProxyCaptureStore = Omit<DebugProxyCaptureStoreImpl, "persistPayload"> & {
  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord;
};

type SharedDebugProxyCaptureStore = Omit<DebugProxyCaptureStoreImpl, "persistPayload"> & {
  persistPayload(data: Buffer, contentType?: string): SharedCaptureBlobRecord;
};

type DebugProxyCaptureStoreConstructor = {
  new (dbPath: string, blobDir: string): LegacyDebugProxyCaptureStore;
  new (options?: DebugProxyCaptureStoreOptions): SharedDebugProxyCaptureStore;
};

// The runtime implementation branches on constructor arguments; expose the
// corresponding result type so both shipped constructor contracts stay exact.
export const DebugProxyCaptureStore =
  DebugProxyCaptureStoreImpl as unknown as DebugProxyCaptureStoreConstructor;

type CachedStoreEntry = {
  store: DebugProxyCaptureStoreImpl;
  leases: number;
};

const cachedStores = new Map<string, CachedStoreEntry>();
let unregisterExitClose: (() => void) | null = null;

function resolveDebugProxyCaptureStoreKey(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string,
  legacyBlobDir?: string,
): string {
  return typeof optionsOrDbPath === "string"
    ? `legacy:${optionsOrDbPath}:${legacyBlobDir ?? ""}`
    : `shared:${openOpenClawStateDatabase({ env: optionsOrDbPath.env }).path}`;
}

function getDebugProxyCaptureStoreImpl(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
  legacyBlobDir?: string,
): DebugProxyCaptureStoreImpl {
  const key = resolveDebugProxyCaptureStoreKey(optionsOrDbPath, legacyBlobDir);
  const cached = cachedStores.get(key);
  if (cached && !cached.store.isClosed) {
    return cached.store;
  }
  const store = new DebugProxyCaptureStoreImpl(optionsOrDbPath, legacyBlobDir);
  cachedStores.set(key, { store, leases: 0 });
  // Safety net for legacy path-based stores that own their DatabaseSync;
  // shared-path stores only flip their closed flag here, never the shared DB.
  unregisterExitClose ??= registerSqliteCacheExitClose(closeDebugProxyCaptureStore);
  return store;
}

export function getDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): LegacyDebugProxyCaptureStore;
export function getDebugProxyCaptureStore(
  options?: DebugProxyCaptureStoreOptions,
): SharedDebugProxyCaptureStore;
export function getDebugProxyCaptureStore(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
  legacyBlobDir?: string,
): DebugProxyCaptureStore {
  return getDebugProxyCaptureStoreImpl(optionsOrDbPath, legacyBlobDir);
}

export function closeDebugProxyCaptureStore(): void {
  unregisterExitClose?.();
  unregisterExitClose = null;
  for (const cached of cachedStores.values()) {
    cached.store.close();
  }
  cachedStores.clear();
}

// Lease API keeps one cached capture-store wrapper alive across related
// operations, then releases it without closing the shared state database.
export function acquireDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): {
  store: LegacyDebugProxyCaptureStore;
  release: () => void;
};
export function acquireDebugProxyCaptureStore(options?: DebugProxyCaptureStoreOptions): {
  store: SharedDebugProxyCaptureStore;
  release: () => void;
};
export function acquireDebugProxyCaptureStore(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
  legacyBlobDir?: string,
): {
  store: DebugProxyCaptureStore;
  release: () => void;
} {
  const key = resolveDebugProxyCaptureStoreKey(optionsOrDbPath, legacyBlobDir);
  const store = getDebugProxyCaptureStoreImpl(optionsOrDbPath, legacyBlobDir);
  const cached = cachedStores.get(key);
  if (!cached || cached.store !== store) {
    throw new Error("debug proxy capture store cache changed while acquiring a lease");
  }
  cached.leases += 1;
  let released = false;
  return {
    store,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = cachedStores.get(key);
      if (!current || current.store !== store) {
        return;
      }
      current.leases = Math.max(0, current.leases - 1);
      if (current.leases === 0) {
        current.store.close();
        cachedStores.delete(key);
      }
    },
  };
}

export function persistEventPayload(
  store: {
    persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord | SharedCaptureBlobRecord;
  },
  params: { data?: Buffer | string | null; contentType?: string; previewLimit?: number },
): { dataText?: string; dataBlobId?: string; dataSha256?: string } {
  if (params.data == null) {
    return {};
  }
  const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data);
  const previewLimit = params.previewLimit ?? 8192;
  // Store the whole payload as a blob but keep a small UTF-8 preview inline for
  // fast CLI listings and query output. write(), unlike end(), omits an incomplete
  // trailing code point introduced by the byte cap instead of injecting U+FFFD.
  const blob = store.persistPayload(buffer, params.contentType);
  return {
    dataText: new StringDecoder("utf8").write(buffer.subarray(0, previewLimit)),
    dataBlobId: blob.blobId,
    dataSha256: blob.sha256,
  };
}

export function safeJsonString(value: unknown): string | undefined {
  const raw = serializeJson(value);
  return raw ?? undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
