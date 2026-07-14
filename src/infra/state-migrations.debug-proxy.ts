// Debug proxy state migration imports the shipped capture sidecar into shared SQLite state.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sha256Hex } from "./crypto-digest.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const DEBUG_PROXY_SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal", "-journal"] as const;

type LegacyDebugProxyCaptureDetection = {
  sourcePath: string;
  blobDir: string;
  hasLegacy: boolean;
};

type LegacyCaptureSessionRow = {
  id: string;
  started_at: number | bigint;
  ended_at: number | bigint | null;
  mode: string;
  source_scope: string;
  source_process: string;
  proxy_url: string | null;
  blob_dir: string;
};

type LegacyCaptureEventRow = {
  session_id: string;
  ts: number | bigint;
  source_scope: string;
  source_process: string;
  protocol: string;
  direction: string;
  kind: string;
  flow_id: string;
  method: string | null;
  host: string | null;
  path: string | null;
  status: number | bigint | null;
  close_code: number | bigint | null;
  content_type: string | null;
  headers_json: string | null;
  data_text: string | null;
  data_blob_id: string | null;
  data_sha256: string | null;
  error_text: string | null;
  meta_json: string | null;
};

type LegacyCaptureBlobRow = {
  blobId: string;
  contentType: string | null;
  encoding: "gzip";
  sizeBytes: number;
  sha256: string;
  data: Buffer;
  createdAt: number;
};

class LegacyDebugProxyBlobConflictError extends Error {
  constructor(readonly blobId: string) {
    super(`legacy debug proxy blob conflicts with shared state: ${blobId}`);
  }
}

class LegacyDebugProxySessionConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`legacy debug proxy session conflicts with shared state: ${sessionId}`);
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveLegacyDebugProxyCapturePaths(
  stateDir: string,
  env: NodeJS.ProcessEnv,
): {
  sourcePath: string;
  blobDir: string;
} {
  const rootDir = path.join(stateDir, "debug-proxy");
  return {
    sourcePath: env.OPENCLAW_DEBUG_PROXY_DB_PATH?.trim() || path.join(rootDir, "capture.sqlite"),
    blobDir: env.OPENCLAW_DEBUG_PROXY_BLOB_DIR?.trim() || path.join(rootDir, "blobs"),
  };
}

function hasPendingSqliteArchive(sourcePath: string): boolean {
  return (
    !fileExists(sourcePath) &&
    fileExists(`${sourcePath}.migrated`) &&
    DEBUG_PROXY_SQLITE_SIDECAR_SUFFIXES.some(
      (suffix) => suffix !== "" && fileExists(`${sourcePath}${suffix}`),
    )
  );
}

export function detectLegacyDebugProxyCaptureSidecar(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): LegacyDebugProxyCaptureDetection {
  const paths = resolveLegacyDebugProxyCapturePaths(stateDir, env);
  if (
    path.resolve(paths.sourcePath) ===
    path.resolve(resolveOpenClawStateSqlitePath({ ...env, OPENCLAW_STATE_DIR: stateDir }))
  ) {
    return { ...paths, hasLegacy: false };
  }
  const hasArchivedDatabase = fileExists(`${paths.sourcePath}.migrated`);
  return {
    ...paths,
    hasLegacy:
      fileExists(paths.sourcePath) ||
      hasPendingSqliteArchive(paths.sourcePath) ||
      (hasArchivedDatabase && dirExists(paths.blobDir)),
  };
}

function listSqliteColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function assertTableColumns(db: DatabaseSync, table: string, expected: readonly string[]): void {
  const columns = listSqliteColumns(db, table);
  const missing = expected.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`legacy ${table} table is missing ${missing.join(", ")}`);
  }
}

function normalizeSqliteInteger(value: number | bigint | null): number | null {
  return typeof value === "bigint" ? Number(value) : value;
}

function readLegacyDebugProxyCapture(params: { sourcePath: string; blobDir: string }): {
  sessions: LegacyCaptureSessionRow[];
  events: LegacyCaptureEventRow[];
  blobs: LegacyCaptureBlobRow[];
  blobDirs: string[];
} {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(params.sourcePath, { readOnly: true });
  try {
    assertTableColumns(db, "capture_sessions", [
      "id",
      "started_at",
      "ended_at",
      "mode",
      "source_scope",
      "source_process",
      "proxy_url",
      "db_path",
      "blob_dir",
    ]);
    assertTableColumns(db, "capture_events", [
      "session_id",
      "ts",
      "source_scope",
      "source_process",
      "protocol",
      "direction",
      "kind",
      "flow_id",
      "method",
      "host",
      "path",
      "status",
      "close_code",
      "content_type",
      "headers_json",
      "data_text",
      "data_blob_id",
      "data_sha256",
      "error_text",
      "meta_json",
    ]);
    const sessions = db
      .prepare(
        `SELECT id, started_at, ended_at, mode, source_scope, source_process, proxy_url, blob_dir
         FROM capture_sessions
         ORDER BY started_at ASC, id ASC`,
      )
      .all() as LegacyCaptureSessionRow[];
    const events = db
      .prepare(
        `SELECT
           session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
           method, host, path, status, close_code, content_type, headers_json, data_text,
           data_blob_id, data_sha256, error_text, meta_json
         FROM capture_events
         ORDER BY ts ASC, id ASC`,
      )
      .all() as LegacyCaptureEventRow[];
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const event of events) {
      if (sessionIds.has(event.session_id)) {
        continue;
      }
      sessions.push({
        id: event.session_id,
        started_at: event.ts,
        ended_at: null,
        mode: "implicit",
        source_scope: event.source_scope,
        source_process: event.source_process,
        proxy_url: null,
        blob_dir: params.blobDir,
      });
      sessionIds.add(event.session_id);
    }

    const blobEvents = new Map<string, LegacyCaptureEventRow[]>();
    for (const event of events) {
      if (!event.data_blob_id) {
        continue;
      }
      const rows = blobEvents.get(event.data_blob_id) ?? [];
      rows.push(event);
      blobEvents.set(event.data_blob_id, rows);
    }
    const blobDirBySession = new Map(
      sessions.map((session) => [session.id, session.blob_dir] as const),
    );
    const usedBlobDirs = new Set<string>();
    const blobs: LegacyCaptureBlobRow[] = [];
    for (const [blobId, referencingEvents] of blobEvents) {
      const candidateBlobDirs = [
        ...new Set([
          ...referencingEvents.map(
            (event) => blobDirBySession.get(event.session_id) ?? params.blobDir,
          ),
          params.blobDir,
        ]),
      ];
      const blobPath =
        candidateBlobDirs
          .map((blobDir) => path.join(blobDir, `${blobId}.bin.gz`))
          .find(fileExists) ??
        path.join(candidateBlobDirs[0] ?? params.blobDir, `${blobId}.bin.gz`);
      const data = fs.readFileSync(blobPath);
      const raw = gunzipSync(data);
      const sha256 = sha256Hex(raw);
      if (sha256.slice(0, 24) !== blobId) {
        throw new Error(`legacy debug proxy blob hash mismatch: ${blobPath}`);
      }
      usedBlobDirs.add(path.dirname(blobPath));
      blobs.push({
        blobId,
        contentType: referencingEvents.find((event) => event.content_type)?.content_type ?? null,
        encoding: "gzip",
        sizeBytes: raw.byteLength,
        sha256,
        data,
        createdAt: Math.min(
          ...referencingEvents.map((event) => normalizeSqliteInteger(event.ts) ?? 0),
        ),
      });
    }
    return { sessions, events, blobs, blobDirs: [...usedBlobDirs] };
  } finally {
    db.close();
  }
}

function eventValues(event: LegacyCaptureEventRow): SQLInputValue[] {
  return [
    event.session_id,
    normalizeSqliteInteger(event.ts),
    event.source_scope,
    event.source_process,
    event.protocol,
    event.direction,
    event.kind,
    event.flow_id,
    event.method,
    event.host,
    event.path,
    normalizeSqliteInteger(event.status),
    normalizeSqliteInteger(event.close_code),
    event.content_type,
    event.headers_json,
    event.data_text,
    event.data_blob_id,
    event.data_sha256,
    event.error_text,
    event.meta_json,
  ];
}

function eventKey(values: SQLInputValue[]): string {
  return JSON.stringify(values);
}

function archiveLegacyDebugProxySqlite(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const existingSources = DEBUG_PROXY_SQLITE_SIDECAR_SUFFIXES.map(
    (suffix) => `${params.sourcePath}${suffix}`,
  ).filter(fileExists);
  if (existingSources.length === 0) {
    return;
  }
  const resolutions: Array<{ sourcePath: string; targetPath: string; removed: boolean }> = [];
  for (const sourcePath of existingSources) {
    const archivedPath = `${sourcePath}.migrated`;
    try {
      if (fileExists(archivedPath)) {
        if (fs.readFileSync(sourcePath).equals(fs.readFileSync(archivedPath))) {
          fs.rmSync(sourcePath, { force: true });
          resolutions.push({ sourcePath, targetPath: archivedPath, removed: true });
          continue;
        }
        let index = 2;
        while (fs.existsSync(`${sourcePath}.migrated.${index}`)) {
          index++;
        }
        const nextArchivePath = `${sourcePath}.migrated.${index}`;
        fs.renameSync(sourcePath, nextArchivePath);
        resolutions.push({ sourcePath, targetPath: nextArchivePath, removed: false });
        continue;
      }
      fs.renameSync(sourcePath, archivedPath);
      resolutions.push({ sourcePath, targetPath: archivedPath, removed: false });
    } catch (err) {
      params.warnings.push(
        `Failed archiving debug proxy capture sidecar ${sourcePath}: ${String(err)}`,
      );
      return;
    }
  }
  if (
    resolutions.every(
      (resolution) =>
        !resolution.removed && resolution.targetPath === `${resolution.sourcePath}.migrated`,
    )
  ) {
    params.changes.push(
      `Archived debug proxy capture sidecar legacy source → ${params.sourcePath}.migrated`,
    );
    return;
  }
  for (const resolution of resolutions) {
    params.changes.push(
      resolution.removed
        ? `Removed already-archived debug proxy capture sidecar legacy source ${resolution.sourcePath}`
        : `Archived debug proxy capture sidecar legacy source → ${resolution.targetPath}`,
    );
  }
}

function archiveLegacyDebugProxyBlobs(params: {
  blobDir: string;
  changes: string[];
  warnings: string[];
}): void {
  if (!dirExists(params.blobDir)) {
    return;
  }
  const archivePath = `${params.blobDir}.migrated`;
  try {
    let targetPath = archivePath;
    if (dirExists(archivePath)) {
      let index = 2;
      while (fs.existsSync(`${params.blobDir}.migrated.${index}`)) {
        index++;
      }
      targetPath = `${params.blobDir}.migrated.${index}`;
    }
    fs.renameSync(params.blobDir, targetPath);
    params.changes.push(`Archived debug proxy capture blobs → ${targetPath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving debug proxy capture blobs ${params.blobDir}: ${String(err)}`,
    );
  }
}

export function migrateLegacyDebugProxyCaptureSidecar(params: {
  stateDir: string;
  detected?: LegacyDebugProxyCaptureDetection;
}): { changes: string[]; warnings: string[] } {
  const detected = params.detected ?? detectLegacyDebugProxyCaptureSidecar(params.stateDir);
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.hasLegacy) {
    return { changes, warnings };
  }
  if (!fileExists(detected.sourcePath)) {
    archiveLegacyDebugProxySqlite({ sourcePath: detected.sourcePath, changes, warnings });
    if (fileExists(`${detected.sourcePath}.migrated`)) {
      archiveLegacyDebugProxyBlobs({ blobDir: detected.blobDir, changes, warnings });
    }
    return { changes, warnings };
  }

  let legacy: ReturnType<typeof readLegacyDebugProxyCapture>;
  try {
    legacy = readLegacyDebugProxyCapture(detected);
  } catch (err) {
    return {
      changes,
      warnings: [
        `Failed reading debug proxy capture sidecar ${detected.sourcePath}: ${String(err)}`,
      ],
    };
  }

  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const selectBlob = db.prepare(
          `SELECT encoding, size_bytes AS sizeBytes, sha256, data
           FROM capture_blobs
           WHERE blob_id = ?`,
        );
        const insertBlob = db.prepare(
          `INSERT INTO capture_blobs (
            blob_id, content_type, encoding, size_bytes, sha256, data, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const blob of legacy.blobs) {
          const existing = selectBlob.get(blob.blobId) as
            | { encoding?: unknown; sizeBytes?: unknown; sha256?: unknown; data?: Uint8Array }
            | undefined;
          if (existing) {
            if (
              existing.encoding !== blob.encoding ||
              Number(existing.sizeBytes) !== blob.sizeBytes ||
              existing.sha256 !== blob.sha256 ||
              !existing.data ||
              !Buffer.from(existing.data).equals(blob.data)
            ) {
              throw new LegacyDebugProxyBlobConflictError(blob.blobId);
            }
            continue;
          }
          insertBlob.run(
            blob.blobId,
            blob.contentType,
            blob.encoding,
            blob.sizeBytes,
            blob.sha256,
            blob.data,
            blob.createdAt,
          );
        }

        const selectSession = db.prepare(
          `SELECT
            started_at AS startedAt,
            ended_at AS endedAt,
            mode,
            source_scope AS sourceScope,
            source_process AS sourceProcess,
            proxy_url AS proxyUrl
           FROM capture_sessions
           WHERE id = ?`,
        );
        const insertSession = db.prepare(
          `INSERT INTO capture_sessions (
            id, started_at, ended_at, mode, source_scope, source_process, proxy_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const session of legacy.sessions) {
          const values = [
            session.id,
            normalizeSqliteInteger(session.started_at),
            normalizeSqliteInteger(session.ended_at),
            session.mode,
            session.source_scope,
            session.source_process,
            session.proxy_url,
          ] satisfies SQLInputValue[];
          const existing = selectSession.get(session.id);
          if (existing) {
            const expected = {
              startedAt: values[1],
              endedAt: values[2],
              mode: values[3],
              sourceScope: values[4],
              sourceProcess: values[5],
              proxyUrl: values[6],
            };
            if (JSON.stringify(existing) !== JSON.stringify(expected)) {
              throw new LegacyDebugProxySessionConflictError(session.id);
            }
            continue;
          }
          insertSession.run(...values);
        }

        const existingEventCount = db.prepare(
          `SELECT COUNT(*) AS count
           FROM capture_events
           WHERE session_id IS ? AND ts IS ? AND source_scope IS ? AND source_process IS ?
             AND protocol IS ? AND direction IS ? AND kind IS ? AND flow_id IS ?
             AND method IS ? AND host IS ? AND path IS ? AND status IS ? AND close_code IS ?
             AND content_type IS ? AND headers_json IS ? AND data_text IS ? AND data_blob_id IS ?
             AND data_sha256 IS ? AND error_text IS ? AND meta_json IS ?
          `,
        );
        const insertEvent = db.prepare(
          `INSERT INTO capture_events (
            session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
            method, host, path, status, close_code, content_type, headers_json, data_text,
            data_blob_id, data_sha256, error_text, meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const existingCounts = new Map<string, number>();
        const seenCounts = new Map<string, number>();
        for (const event of legacy.events) {
          const values = eventValues(event);
          const key = eventKey(values);
          const seenCount = (seenCounts.get(key) ?? 0) + 1;
          seenCounts.set(key, seenCount);
          let existingCount = existingCounts.get(key);
          if (existingCount === undefined) {
            const row = existingEventCount.get(...values) as { count?: unknown } | undefined;
            existingCount = Number(row?.count ?? 0);
            existingCounts.set(key, existingCount);
          }
          if (seenCount > existingCount) {
            insertEvent.run(...values);
          }
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
    changes.push(
      `Migrated ${legacy.sessions.length} debug proxy capture ${legacy.sessions.length === 1 ? "session" : "sessions"}, ${legacy.events.length} ${legacy.events.length === 1 ? "event" : "events"}, and ${legacy.blobs.length} ${legacy.blobs.length === 1 ? "blob" : "blobs"} → shared SQLite state`,
    );
  } catch (err) {
    const detail =
      err instanceof LegacyDebugProxyBlobConflictError
        ? `blob ${err.blobId} already exists with different data`
        : err instanceof LegacyDebugProxySessionConflictError
          ? `session ${err.sessionId} already exists with different data`
          : String(err);
    return {
      changes,
      warnings: [`Failed migrating debug proxy capture sidecar ${detected.sourcePath}: ${detail}`],
    };
  }

  archiveLegacyDebugProxySqlite({ sourcePath: detected.sourcePath, changes, warnings });
  if (!fileExists(detected.sourcePath) && fileExists(`${detected.sourcePath}.migrated`)) {
    archiveLegacyDebugProxyBlobs({ blobDir: detected.blobDir, changes, warnings });
    for (const blobDir of legacy.blobDirs) {
      if (path.resolve(blobDir) === path.resolve(detected.blobDir) || !dirExists(blobDir)) {
        continue;
      }
      warnings.push(
        `Left migrated debug proxy capture blobs in stored session directory: ${blobDir}`,
      );
    }
  }
  return { changes, warnings };
}
