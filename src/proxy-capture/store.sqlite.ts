import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readCaptureBlobText, writeCaptureBlob } from "./blob-store.js";
import type {
  CaptureBlobRecord,
  CaptureEventRecord,
  CaptureObservedDimension,
  CaptureQueryPreset,
  CaptureQueryRow,
  CaptureSessionCoverageSummary,
  CaptureSessionRecord,
  CaptureSessionSummary,
} from "./types.js";

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openDatabase(dbPath: string): DatabaseSync {
  ensureParentDir(dbPath);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
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
  return db;
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

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

function normalizeObservedValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sortObservedCounts(counts: Map<string, number>): CaptureObservedDimension[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export class DebugProxyCaptureStore {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(
    readonly dbPath: string,
    readonly blobDir: string,
  ) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  upsertSession(session: CaptureSessionRecord): void {
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
        session.dbPath,
        session.blobDir,
      );
  }

  endSession(sessionId: string, endedAt = Date.now()): void {
    this.db
      .prepare(`UPDATE capture_sessions SET ended_at = ? WHERE id = ?`)
      .run(endedAt, sessionId);
  }

  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord {
    return writeCaptureBlob({ blobDir: this.blobDir, data, contentType });
  }

  recordEvent(event: CaptureEventRecord): void {
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
        event.dataBlobId ?? null,
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
    const row = this.db
      .prepare(`SELECT data_blob_id AS blobId FROM capture_events WHERE data_blob_id = ? LIMIT 1`)
      .get(blobId) as { blobId?: string } | undefined;
    if (!row?.blobId) {
      return null;
    }
    const blobPath = path.join(this.blobDir, `${row.blobId}.bin.gz`);
    return fs.existsSync(blobPath) ? readCaptureBlobText(blobPath) : null;
  }

  queryPreset(preset: CaptureQueryPreset, sessionId?: string): CaptureQueryRow[] {
    const sessionWhere = sessionId ? "AND session_id = ?" : "";
    const args = sessionId ? [sessionId] : [];
    switch (preset) {
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
    const sessionCount =
      (this.db.prepare(`SELECT COUNT(*) AS count FROM capture_sessions`).get() as { count: number })
        .count ?? 0;
    const eventCount =
      (this.db.prepare(`SELECT COUNT(*) AS count FROM capture_events`).get() as { count: number })
        .count ?? 0;
    this.db.exec(`DELETE FROM capture_events; DELETE FROM capture_sessions;`);
    let blobs = 0;
    if (fs.existsSync(this.blobDir)) {
      for (const entry of fs.readdirSync(this.blobDir)) {
        fs.rmSync(path.join(this.blobDir, entry), { force: true });
        blobs += 1;
      }
    }
    return { sessions: sessionCount, events: eventCount, blobs };
  }

  deleteSessions(sessionIds: string[]): { sessions: number; events: number; blobs: number } {
    const uniqueSessionIds = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueSessionIds.length === 0) {
      return { sessions: 0, events: 0, blobs: 0 };
    }
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
    for (const row of blobRows) {
      const blobId = row.blobId?.trim();
      if (!blobId || remainingBlobRefs.has(blobId)) {
        continue;
      }
      const blobPath = path.join(this.blobDir, `${blobId}.bin.gz`);
      if (fs.existsSync(blobPath)) {
        fs.rmSync(blobPath, { force: true });
        blobs += 1;
      }
    }
    return { sessions: sessionCount, events: eventCount, blobs };
  }
}

let cachedStore: DebugProxyCaptureStore | null = null;
let cachedKey = "";
let cachedStoreLeases = 0;

export function getDebugProxyCaptureStore(dbPath: string, blobDir: string): DebugProxyCaptureStore {
  const key = `${dbPath}:${blobDir}`;
  if (!cachedStore || cachedStore.isClosed || cachedKey !== key) {
    cachedStore = new DebugProxyCaptureStore(dbPath, blobDir);
    cachedKey = key;
    cachedStoreLeases = 0;
  }
  return cachedStore;
}

export function closeDebugProxyCaptureStore(): void {
  if (!cachedStore) {
    return;
  }
  cachedStore.close();
  cachedStore = null;
  cachedKey = "";
  cachedStoreLeases = 0;
}

export function acquireDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): { store: DebugProxyCaptureStore; release: () => void } {
  const store = getDebugProxyCaptureStore(dbPath, blobDir);
  const key = cachedKey;
  cachedStoreLeases += 1;
  let released = false;
  return {
    store,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      cachedStoreLeases = Math.max(0, cachedStoreLeases - 1);
      if (cachedStoreLeases === 0 && cachedStore === store && cachedKey === key) {
        closeDebugProxyCaptureStore();
      }
    },
  };
}

export function persistEventPayload(
  store: DebugProxyCaptureStore,
  params: { data?: Buffer | string | null; contentType?: string; previewLimit?: number },
): { dataText?: string; dataBlobId?: string; dataSha256?: string } {
  if (params.data == null) {
    return {};
  }
  const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data);
  const previewLimit = params.previewLimit ?? 8192;
  const blob = store.persistPayload(buffer, params.contentType);
  return {
    dataText: buffer.subarray(0, previewLimit).toString("utf8"),
    dataBlobId: blob.blobId,
    dataSha256: blob.sha256,
  };
}

export function safeJsonString(value: unknown): string | undefined {
  const raw = serializeJson(value);
  return raw ?? undefined;
}
