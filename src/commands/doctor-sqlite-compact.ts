/** Shared doctor-only SQLite compaction mechanics. */
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite, resolveNodeSqliteLocation } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";

export type DoctorSqliteCompactSnapshot = {
  autoVacuum: number;
  dbSizeBytes: number;
  freelistPages: number;
  pageSizeBytes: number;
  walSizeBytes: number;
};

type DoctorSqliteCompactResult = {
  after: DoctorSqliteCompactSnapshot;
  before: DoctorSqliteCompactSnapshot;
  integrityCheck: "ok";
  reclaimedBytes: number;
};

type DoctorSqliteCompactOptions = {
  afterSuccess?: () => void;
  busyTimeoutMs?: number;
  sqlitePath: string;
  validateBeforeMutation?: (database: DatabaseSync) => void;
};

/**
 * Compact one SQLite file during an explicit offline doctor operation.
 *
 * Validation runs before the first checkpoint because checkpointing mutates
 * the database files. A busy checkpoint is a hard failure, never partial
 * success, so VACUUM cannot race an active reader or writer.
 */
export function compactDoctorSqliteFile(
  options: DoctorSqliteCompactOptions,
): DoctorSqliteCompactResult {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(resolveNodeSqliteLocation(options.sqlitePath));
  let operationError: unknown;
  let result: DoctorSqliteCompactResult | undefined;
  try {
    database.exec(
      `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`,
    );
    database.exec("PRAGMA trusted_schema = OFF;");
    options.validateBeforeMutation?.(database);
    const before = readCompactSnapshot(database, options.sqlitePath);
    assertSqliteIntegrity(database, options.sqlitePath);
    checkpointTruncate(database, options.sqlitePath);
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    database.exec("VACUUM;");
    checkpointTruncate(database, options.sqlitePath);
    const { integrityCheck } = assertSqliteIntegrity(database, options.sqlitePath);
    const after = readCompactSnapshot(database, options.sqlitePath);
    const beforeBytes = before.dbSizeBytes + before.walSizeBytes;
    const afterBytes = after.dbSizeBytes + after.walSizeBytes;
    result = {
      after,
      before,
      integrityCheck,
      reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    };
  } catch (error) {
    operationError = error;
  }
  try {
    database.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError === undefined && result) {
    try {
      options.afterSuccess?.();
    } catch (error) {
      operationError ??= error;
    }
  }
  if (operationError !== undefined) {
    throw operationError instanceof Error
      ? operationError
      : new Error("SQLite compaction failed with a non-Error value.");
  }
  if (!result) {
    throw new Error(`SQLite compaction produced no result for ${options.sqlitePath}.`);
  }
  return result;
}

function checkpointTruncate(database: DatabaseSync, sqlitePath: string): void {
  const row = database.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get() as
    | Record<string, unknown>
    | undefined;
  const busy = readFiniteNumber(row?.busy ?? (row ? Object.values(row)[0] : undefined));
  if (busy === undefined) {
    throw new Error(`SQLite checkpoint returned an invalid result for ${sqlitePath}.`);
  }
  if (busy !== 0) {
    throw new Error(`SQLite checkpoint remained busy for ${sqlitePath}. Stop OpenClaw and retry.`);
  }
}

function readCompactSnapshot(
  database: DatabaseSync,
  sqlitePath: string,
): DoctorSqliteCompactSnapshot {
  return {
    autoVacuum: readPragmaNumber(database, "auto_vacuum"),
    dbSizeBytes: fileSize(sqlitePath),
    freelistPages: readPragmaNumber(database, "freelist_count"),
    pageSizeBytes: readPragmaNumber(database, "page_size"),
    walSizeBytes: fileSize(`${sqlitePath}-wal`),
  };
}

function readPragmaNumber(
  database: DatabaseSync,
  pragmaName: "auto_vacuum" | "freelist_count" | "page_size",
): number {
  const row = database.prepare(`PRAGMA ${pragmaName};`).get() as
    | Record<string, unknown>
    | undefined;
  const value = readFiniteNumber(row?.[pragmaName] ?? (row ? Object.values(row)[0] : undefined));
  if (value === undefined) {
    throw new Error(`SQLite PRAGMA ${pragmaName} returned an invalid result.`);
  }
  return value;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}
