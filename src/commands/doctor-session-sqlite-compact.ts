/** Runs doctor-owned SQLite file compaction for migrated session stores. */
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type { DoctorSessionSqliteCompactReport } from "./doctor-session-sqlite-types.js";

type SqliteFileCompactSnapshot = {
  dbSizeBytes: number;
  freelistPages: number;
  pageSizeBytes: number;
  walSizeBytes: number;
};

/** Reclaim free pages from one agent session SQLite database. */
export function compactDoctorSessionSqliteTarget(
  target: SessionStoreTarget,
): DoctorSessionSqliteCompactReport {
  const sqlitePath = resolveTargetSqlitePath(target);
  const beforeFileSizes = readSqliteFileSizes(sqlitePath);
  if (!fs.existsSync(sqlitePath)) {
    return {
      dbSizeAfterBytes: 0,
      dbSizeBeforeBytes: 0,
      freelistAfterPages: 0,
      freelistBeforePages: 0,
      pageSizeBytes: 0,
      reclaimedBytes: 0,
      skipped: true,
      walSizeAfterBytes: beforeFileSizes.walSizeBytes,
      walSizeBeforeBytes: beforeFileSizes.walSizeBytes,
    };
  }

  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    checkpointTruncate(database);
    const before = readCompactSnapshot(database, sqlitePath);
    // Doctor's offline VACUUM is the one sanctioned window to retrofit
    // incremental auto-vacuum onto databases created before the pragma
    // existed; runtime maintenance then releases pages in bounded passes.
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    database.exec("VACUUM;");
    checkpointTruncate(database);
    const after = readCompactSnapshot(database, sqlitePath);
    return {
      dbSizeAfterBytes: after.dbSizeBytes,
      dbSizeBeforeBytes: before.dbSizeBytes,
      freelistAfterPages: after.freelistPages,
      freelistBeforePages: before.freelistPages,
      pageSizeBytes: before.pageSizeBytes || after.pageSizeBytes,
      reclaimedBytes: Math.max(0, before.dbSizeBytes - after.dbSizeBytes),
      skipped: false,
      walSizeAfterBytes: after.walSizeBytes,
      walSizeBeforeBytes: before.walSizeBytes,
    };
  } finally {
    database.close();
  }
}

function checkpointTruncate(database: DatabaseSync): void {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

function readCompactSnapshot(
  database: DatabaseSync,
  sqlitePath: string,
): SqliteFileCompactSnapshot {
  const sizes = readSqliteFileSizes(sqlitePath);
  return {
    dbSizeBytes: sizes.dbSizeBytes,
    freelistPages: readPragmaNumber(database, "freelist_count"),
    pageSizeBytes: readPragmaNumber(database, "page_size"),
    walSizeBytes: sizes.walSizeBytes,
  };
}

function readPragmaNumber(
  database: DatabaseSync,
  pragmaName: "freelist_count" | "page_size",
): number {
  const row = database.prepare(`PRAGMA ${pragmaName};`).get() as
    | Record<string, unknown>
    | undefined;
  const value = row?.[pragmaName] ?? (row ? Object.values(row)[0] : undefined);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return 0;
}

function readSqliteFileSizes(sqlitePath: string): { dbSizeBytes: number; walSizeBytes: number } {
  return {
    dbSizeBytes: fileSize(sqlitePath),
    walSizeBytes: fileSize(`${sqlitePath}-wal`),
  };
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
