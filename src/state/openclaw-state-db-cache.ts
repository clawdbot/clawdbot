import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  registerNodeSqliteKyselyQueryErrorHandler,
} from "../infra/kysely-sync-cache-state.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { isSqliteCorruptionError } from "../infra/sqlite-transaction.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { readOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { createOpenClawDatabaseVerificationError } from "./openclaw-state-db-maintenance.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";

const cachedDatabases = new Map<string, OpenClawStateDatabase>();
const cachedDataVersionStatements = new WeakMap<
  DatabaseSync,
  ReturnType<DatabaseSync["prepare"]>
>();
const cachedDataVersions = new WeakMap<DatabaseSync, number>();
type OpenClawStateDatabaseLifecycleEvent =
  | { kind: "opened"; database: OpenClawStateDatabase }
  | { kind: "closed"; path: string }
  | { kind: "open-error"; path: string; error: unknown };
const databaseLifecycleListeners = new Set<(event: OpenClawStateDatabaseLifecycleEvent) => void>();

function notifyOpenClawStateDatabaseLifecycle(event: OpenClawStateDatabaseLifecycleEvent): void {
  for (const listener of databaseLifecycleListeners) {
    listener(event);
  }
}

function readSqliteDataVersion(database: DatabaseSync): number {
  let statement = cachedDataVersionStatements.get(database);
  if (!statement) {
    statement = database /* sqlite-allow-raw -- Connection-local schema compatibility counter. */
      .prepare("PRAGMA data_version");
    cachedDataVersionStatements.set(database, statement);
  }
  // SAFETY: SQLite defines this pragma's single-column row; the value is validated below.
  const row = statement.get() as { data_version?: unknown } | undefined;
  if (typeof row?.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}

export function registerOpenClawStateDatabaseLifecycleListener(
  listener: (event: OpenClawStateDatabaseLifecycleEvent) => void,
): () => void {
  databaseLifecycleListeners.add(listener);
  for (const database of cachedDatabases.values()) {
    if (database.db.isOpen) {
      listener({ kind: "opened", database });
    }
  }
  return () => databaseLifecycleListeners.delete(listener);
}

/** Close both physical-handle owners while retaining every cleanup failure. */
function closeOpenClawStateDatabaseHandle(
  database: OpenClawStateDatabase,
  options?: Parameters<OpenClawStateDatabase["walMaintenance"]["close"]>[0],
): unknown[] {
  const errors: unknown[] = [];
  try {
    database.walMaintenance.close(options);
  } catch (error) {
    errors.push(error);
  }
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  try {
    if (database.db.isOpen) {
      database.db.close();
    }
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

function evictCachedOpenClawStateDatabase(database: OpenClawStateDatabase): boolean {
  if (cachedDatabases.get(database.path) !== database) {
    return false;
  }
  // Remove ownership before cleanup. A poisoned native handle can reject close,
  // but it must never remain discoverable as the process-wide shared handle.
  cachedDatabases.delete(database.path);
  notifyOpenClawStateDatabaseLifecycle({ kind: "closed", path: database.path });
  // A poisoned cache owner is not the database lifecycle owner. PASSIVE avoids
  // waiting on readers or resetting recovery frames another connection needs.
  closeOpenClawStateDatabaseHandle(database, { checkpointMode: "PASSIVE" });
  return true;
}

/** Evict an exact cached shared-state owner after a proven corruption read. */
function evictOpenClawStateDatabaseAfterCorruption(
  database: OpenClawStateDatabase,
  error: unknown,
): boolean {
  return isSqliteCorruptionError(error) && evictCachedOpenClawStateDatabase(database);
}

const terminalOpenLatch = createSqliteTerminalOpenLatch({
  closeByPath: (pathname) => {
    const cached = cachedDatabases.get(pathname);
    if (cached) {
      evictCachedOpenClawStateDatabase(cached);
    }
  },
});

/** Publish a fully opened handle and bind query corruption to its exact cache owner. */
function publishOpenClawStateDatabase(database: OpenClawStateDatabase): OpenClawStateDatabase {
  const { db, path: pathname } = database;
  cachedDataVersions.set(db, readSqliteDataVersion(db));
  cachedDatabases.set(pathname, database);
  notifyOpenClawStateDatabaseLifecycle({ kind: "opened", database });
  registerNodeSqliteKyselyQueryErrorHandler(db, (error) => {
    // Write transactions own rollback and evict at their outer boundary.
    if (!db.isTransaction && isSqliteCorruptionError(error)) {
      evictCachedOpenClawStateDatabase(database);
    }
  });
  terminalOpenLatch.clear(pathname);
  return database;
}

/** Revalidate a cached owner after another connection commits to its database. */
function getOpenClawStateDatabaseRuntimeFailure(pathname: string): Error | undefined {
  const resolvedPath = path.resolve(pathname);
  const latched = terminalOpenLatch.get(resolvedPath);
  if (latched) {
    return latched;
  }
  const cached = cachedDatabases.get(resolvedPath);
  if (!cached?.db.isOpen) {
    return undefined;
  }
  try {
    const dataVersion = readSqliteDataVersion(cached.db);
    if (cachedDataVersions.get(cached.db) === dataVersion) {
      return undefined;
    }
    // data_version is the cheap external-commit trigger. Re-read user_version
    // only when another connection changed the file.
    assertSupportedStateSchemaVersion(cached.db, resolvedPath);
    cachedDataVersions.set(cached.db, dataVersion);
    return undefined;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (isSqliteCorruptionError(failure)) {
      evictCachedOpenClawStateDatabase(cached);
      return undefined;
    }
    if (isSqliteSchemaVersionError(failure)) {
      terminalOpenLatch.record(resolvedPath, failure);
      notifyOpenClawStateDatabaseLifecycle({
        kind: "open-error",
        path: resolvedPath,
        error: failure,
      });
    }
    return failure;
  }
}

function getCachedOpenClawStateDatabase(pathname: string): OpenClawStateDatabase | undefined {
  const runtimeFailure = getOpenClawStateDatabaseRuntimeFailure(pathname);
  if (runtimeFailure) {
    throw runtimeFailure;
  }
  return cachedDatabases.get(path.resolve(pathname));
}

function getOpenClawStateDatabaseIfOpenAtPath(pathname: string): OpenClawStateDatabase | undefined {
  const cached = getCachedOpenClawStateDatabase(pathname);
  return cached?.db.isOpen ? cached : undefined;
}

/** Remove a closed cached owner while fresh-open access is held. */
function closeStaleCachedOpenClawStateDatabase(database: OpenClawStateDatabase): void {
  if (cachedDatabases.get(database.path) !== database) {
    return;
  }
  database.walMaintenance.close();
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  cachedDatabases.delete(database.path);
  notifyOpenClawStateDatabaseLifecycle({ kind: "closed", path: database.path });
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawStateDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  return terminalOpenLatch.record(pathname, error, generation);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
export function clearOpenClawStateDatabaseOpenFailure(pathname: string): void {
  terminalOpenLatch.clear(pathname);
}

/** Reject shared-state access after a process-local terminal failure. */
function assertOpenClawStateDatabaseOpenAllowed(pathname: string): void {
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
}

function recordOpenClawStateDatabaseLifecycleOpenError(pathname: string, error: unknown): void {
  notifyOpenClawStateDatabaseLifecycle({ kind: "open-error", path: path.resolve(pathname), error });
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
  pathname: string,
  env: NodeJS.ProcessEnv,
): void {
  assertOpenClawStateDatabaseOpenAllowed(pathname);
  let quarantineFailure: Error | undefined;
  try {
    const quarantine = readOpenClawDatabaseQuarantine(pathname, { env });
    if (quarantine) {
      quarantineFailure = createOpenClawDatabaseVerificationError(
        "state",
        pathname,
        quarantine.reason,
      );
    }
  } catch {
    // A broken quarantine store must not brick every state read.
    // The process latch and daily verifier still cover known damage.
  }
  if (quarantineFailure) {
    throw quarantineFailure;
  }
}

/** Close one cached shared state database handle by exact pathname. */
export function closeOpenClawStateDatabaseByPath(pathname: string): boolean {
  const resolvedPath = path.resolve(pathname);
  const database = cachedDatabases.get(resolvedPath);
  if (!database) {
    return false;
  }
  database.walMaintenance.close();
  if (database.db.isOpen) {
    database.db.close();
  }
  cachedDatabases.delete(resolvedPath);
  notifyOpenClawStateDatabaseLifecycle({ kind: "closed", path: resolvedPath });
  return true;
}

/** Close all cached shared state database handles. */
export function closeOpenClawStateDatabase(
  options?: Parameters<OpenClawStateDatabase["walMaintenance"]["close"]>[0],
): void {
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close(options);
    if (database.db.isOpen) {
      database.db.close();
    }
    notifyOpenClawStateDatabaseLifecycle({ kind: "closed", path: database.path });
  }
  cachedDatabases.clear();
}

/** Test whether a cached shared state database handle is still open, optionally at one path. */
export function isOpenClawStateDatabaseOpen(pathname?: string): boolean {
  if (pathname !== undefined) {
    return cachedDatabases.get(path.resolve(pathname))?.db.isOpen === true;
  }
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

/** Close shared state handles and clear terminal failure latches for test isolation. */
export function closeOpenClawStateDatabaseForTest(): void {
  closeOpenClawStateDatabase();
  terminalOpenLatch.clearAll();
}

/** Process-wide owner for cached shared-state handles and terminal open failures. */
export const openClawStateDatabaseCache = {
  assertOpenClawStateDatabaseFreshOpenAllowedAtPath,
  assertOpenClawStateDatabaseOpenAllowed,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseHandle,
  closeStaleCachedOpenClawStateDatabase,
  evictCachedOpenClawStateDatabase,
  evictOpenClawStateDatabaseAfterCorruption,
  getCachedOpenClawStateDatabase,
  getOpenClawStateDatabaseRuntimeFailure,
  getOpenClawStateDatabaseIfOpenAtPath,
  isOpenClawStateDatabaseOpen,
  publishOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
  recordOpenClawStateDatabaseLifecycleOpenError,
};
