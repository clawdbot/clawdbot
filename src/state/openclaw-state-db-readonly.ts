import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  prepareSqliteReadOnlyLocationSync,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "../infra/sqlite-readonly-location.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type OpenClawStateReadOnlyDatabase = {
  db: DatabaseSync;
  path: string;
};

type ReusedOpenClawStateReadOnlyDatabase<T> = { reused: false } | { reused: true; value: T };

function resolveReadOnlyPath(options: OpenClawStateDatabaseOptions): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

function existingPathOrUndefined(pathname: string): string | undefined {
  try {
    statSync(pathname);
    return pathname;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function withOpenClawStateDatabaseReadOnlyIfOpen<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
): ReusedOpenClawStateReadOnlyDatabase<T> {
  const opened = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname);
  if (!opened || opened.db.isTransaction) {
    return { reused: false };
  }
  try {
    // Process-local terminal failures evict this handle. Persisted quarantine
    // is checked on the next physical open so hot reads do not poll metadata.
    // A newer build can migrate this file while the handle stays open, so the
    // forward-compatibility gate still runs before any reused read.
    assertSupportedStateSchemaVersion(opened.db, pathname);
    return { reused: true, value: operation(opened) };
  } catch (error) {
    openClawStateDatabaseCache.evictOpenClawStateDatabaseAfterCorruption(opened, error);
    throw error;
  }
}

function withFreshOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions,
  pathname: string,
  location = pathname,
): T {
  const env = options.env ?? process.env;
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  const db = openNodeSqliteDatabase(location, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedStateSchemaVersion(db, pathname);
    return operation({ db, path: pathname });
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}

/**
 * Read shared state without joining the writable lifecycle.
 *
 * CLI metadata reads can overlap a live Gateway. Keep them off schema repair,
 * journal-mode setup, checkpoints, and permission mutation owned by writers.
 */
export function withOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const pathname = resolveReadOnlyPath(options);
  // Reusing a handle this process already holds keeps row loops cheap: opening
  // and closing a connection per call made shared-state reads scale with row
  // count. An in-flight transaction is skipped so callers never observe
  // uncommitted rows a fresh read-only connection could not have seen.
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  return withFreshOpenClawStateDatabaseReadOnly(operation, options, pathname);
}

/** Read existing shared state while preserving non-missing filesystem failures. */
export function withExistingOpenClawStateDatabaseReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveReadOnlyPath(options);
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  const existingPath = existingPathOrUndefined(pathname);
  return existingPath === undefined
    ? undefined
    : withFreshOpenClawStateDatabaseReadOnly(operation, options, existingPath);
}

/** Read existing shared state without creating or updating its SQLite sidecars. */
export function withExistingOpenClawStateDatabaseArtifactPreservingReadOnly<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveReadOnlyPath(options);
  const reused = withOpenClawStateDatabaseReadOnlyIfOpen(operation, pathname);
  if (reused.reused) {
    return reused.value;
  }
  const existingPath = existingPathOrUndefined(pathname);
  if (existingPath === undefined) {
    return undefined;
  }
  // In-process preparation is safe only when this process holds no writable
  // handle. Otherwise closing the snapshot source can drop the writer's POSIX locks.
  const prepare = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname)
    ? prepareSqliteReadOnlyLocationSync
    : prepareSqliteReadOnlyLocationSyncInProcess;
  const prepared = prepare(existingPath);
  try {
    return withFreshOpenClawStateDatabaseReadOnly(
      operation,
      options,
      existingPath,
      prepared.location,
    );
  } finally {
    prepared.cleanup();
  }
}
