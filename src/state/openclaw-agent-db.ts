// OpenClaw agent database stores agent-scoped persisted runtime state.
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { isTerminalSqliteIntegrityError } from "../infra/sqlite-integrity.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  registerSqliteCacheExitClose,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseOwnerInspection,
} from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  assertAgentDatabaseIntegrityBeforeMutation,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import {
  createOpenClawDatabaseVerificationError,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

export {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
  type OpenClawAgentDatabaseOwnerInspection,
  type OpenClawRegisteredAgentDatabase,
} from "./openclaw-agent-db-contract.js";
export {
  assertOpenClawAgentDatabaseForMaintenance,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "./openclaw-agent-db-maintenance.js";
export { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
export { listOpenClawRegisteredAgentDatabases } from "./openclaw-agent-db-registry.js";
export { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
export { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";

/**
 * Per-agent SQLite database lifecycle and shared-state registration.
 *
 * Each opened agent database is schema-owned by one normalized agent id, cached
 * per pathname, protected with private file modes, and registered in the shared
 * OpenClaw state database for discovery and maintenance.
 */
const OPENCLAW_AGENT_DB_SLOW_OPEN_MS = 1_000;
const agentDbLog = createSubsystemLogger("state/agent-db");
const cachedDatabases = new Map<string, OpenClawAgentDatabase>();
const terminalOpenLatch = createSqliteTerminalOpenLatch({
  closeByPath: closeOpenClawAgentDatabaseByPath,
});

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawAgentDatabaseOpenFailure(pathname: string, error: Error): void {
  terminalOpenLatch.record(pathname, error);
}

/**
 * Clear a terminal open failure after doctor rewrites the database file.
 * Returns false when the persisted quarantine row survived; callers must
 * surface that, or the next open re-quarantines the repaired file.
 */
export function clearOpenClawAgentDatabaseOpenFailure(
  pathname: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  const cleared = clearOpenClawDatabaseQuarantine(resolvedPath, { env: options.env });
  terminalOpenLatch.clear(resolvedPath);
  return cleared;
}

function logSlowAgentDatabaseOpen(params: {
  agentId: string;
  elapsedMs: number;
  path: string;
}): void {
  if (params.elapsedMs < OPENCLAW_AGENT_DB_SLOW_OPEN_MS) {
    return;
  }
  agentDbLog.warn("slow OpenClaw agent database open", {
    agentId: params.agentId,
    elapsedMs: params.elapsedMs,
    path: params.path,
    thresholdMs: OPENCLAW_AGENT_DB_SLOW_OPEN_MS,
  });
}

/** Read a database's durable role and agent owner without mutating it. */
export function inspectOpenClawAgentDatabaseOwner(
  pathname: string,
): OpenClawAgentDatabaseOwnerInspection {
  const sqlite = requireNodeSqlite();
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(pathname, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedAgentSchemaVersion(db, pathname);
    const existing = readExistingAgentSchemaMeta(db);
    if (!existing) {
      return { status: "unowned" };
    }
    if (existing.role !== "agent" || !existing.agentId) {
      return { status: "unreadable" };
    }
    return { status: "owned", agentId: normalizeAgentId(existing.agentId) };
  } catch {
    return { status: "unreadable" };
  } finally {
    db?.close();
  }
}

/** Open or return a cached per-agent database after schema and owner validation. */
export function openOpenClawAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  // A live cached handle is authoritative: the recorder closes handles when it
  // latches, so a cache hit implies the path is not quarantined in this process.
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    if (cached.agentId !== agentId) {
      throw new Error(
        `OpenClaw agent database ${pathname} is already open for agent ${cached.agentId}; requested agent ${agentId}.`,
      );
    }
    return cached;
  }
  // Latched paths are quarantined; every fresh open fails fast here until
  // doctor repairs the file and clears the latch plus the persisted row.
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
  let persistedFailure: Error | undefined;
  try {
    const quarantine = readOpenClawDatabaseQuarantine(pathname, { env: databaseOptions.env });
    if (quarantine) {
      persistedFailure = createOpenClawDatabaseVerificationError(
        "agent",
        pathname,
        quarantine.reason,
      );
    }
  } catch {
    // A broken quarantine store must not brick every agent open.
    // The process latch and daily verifier still cover known damage.
  }
  if (persistedFailure) {
    recordOpenClawAgentDatabaseOpenFailure(pathname, persistedFailure);
    throw persistedFailure;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }
  const openStartedAt = Date.now();
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = (() => {
    let maintenance: OpenClawAgentDatabase["walMaintenance"] | undefined;
    try {
      db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      assertSupportedAgentSchemaVersion(db, pathname);
      assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
      assertAgentDatabaseIntegrityBeforeMutation(db, pathname);
      configureSqlitePreSchemaPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: `openclaw-agent:${agentId}`,
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureOpenClawAgentSchema(db, agentId, pathname);
      return maintenance;
    } catch (err) {
      maintenance?.close();
      db.close();
      if (
        err instanceof Error &&
        (err.name === "SqliteSchemaVersionError" || isTerminalSqliteIntegrityError(err))
      ) {
        recordOpenClawAgentDatabaseOpenFailure(pathname, err);
      }
      throw err;
    }
  })();
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const database = { agentId, db, path: pathname, walMaintenance };
  try {
    registerOpenClawAgentDatabase({ agentId, path: pathname, env: options.env });
  } catch (error) {
    closeCachedOpenClawAgentDatabase(database);
    throw error;
  }
  cachedDatabases.set(pathname, database);
  terminalOpenLatch.clear(pathname);
  // Safety net for processes that end without an orderly close: agent DBs have
  // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
  unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
  logSlowAgentDatabaseOpen({
    agentId,
    elapsedMs: Date.now() - openStartedAt,
    path: pathname,
  });
  return database;
}

/** Run a synchronous immediate transaction against an agent database. */
const postCommitPublications = new WeakMap<OpenClawAgentDatabase, Array<() => void>>();

/** Queue a non-throwing runtime publication on the outer database commit edge. */
export function deferOpenClawAgentPostCommitPublication(
  database: OpenClawAgentDatabase,
  publish: () => void,
): boolean {
  const publications = postCommitPublications.get(database);
  if (!publications) {
    return false;
  }
  publications.push(publish);
  return true;
}

export function runOpenClawAgentWriteTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const database = openOpenClawAgentDatabase(options);
  const enteredNestedTransaction = database.db.isTransaction;
  const publications: Array<() => void> | undefined = enteredNestedTransaction
    ? postCommitPublications.get(database)
    : [];
  const publicationStart = publications?.length ?? 0;
  if (!enteredNestedTransaction && publications) {
    postCommitPublications.set(database, publications);
  }
  let result: T;
  try {
    result = runSqliteImmediateTransactionSync(
      database.db,
      () => {
        const operationResult = operation(database);
        if (!enteredNestedTransaction) {
          // Permission failure must roll back with the write. Repairing after
          // COMMIT could make callers retry a transaction already durable in SQLite.
          ensureOpenClawAgentDatabasePermissions(database.path, options);
        }
        return operationResult;
      },
      {
        busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
      },
    );
  } catch (error) {
    publications?.splice(publicationStart);
    throw error;
  } finally {
    if (!enteredNestedTransaction && publications) {
      postCommitPublications.delete(database);
    }
  }
  if (!enteredNestedTransaction) {
    for (const publish of publications ?? []) {
      publish();
    }
  }
  return result;
}

let unregisterExitClose: (() => void) | null = null;

function closeCachedOpenClawAgentDatabase(database: OpenClawAgentDatabase): void {
  database.walMaintenance.close();
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  if (database.db.isOpen) {
    database.db.close();
  }
}

/** Return whether the exact cached agent database pathname is still open. */
export function isOpenClawAgentDatabaseOpen(pathname: string): boolean {
  const database = cachedDatabases.get(path.resolve(pathname));
  return database?.db.isOpen === true;
}

/** Close one cached agent database identified by its exact resolved pathname. */
export function closeOpenClawAgentDatabaseByPath(pathname: string): boolean {
  // Cache keys are lexical resolved paths. Do not realpath aliases here: a
  // symlink swap must never redirect cleanup onto a different cached database.
  const resolvedPath = path.resolve(pathname);
  const database = cachedDatabases.get(resolvedPath);
  if (!database) {
    return false;
  }
  closeCachedOpenClawAgentDatabase(database);
  cachedDatabases.delete(resolvedPath);
  if (cachedDatabases.size === 0) {
    unregisterExitClose?.();
    unregisterExitClose = null;
  }
  return true;
}

/** Close and unregister one transient agent database by exact cached pathname. */
export function disposeOpenClawAgentDatabaseByPath(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  // Require the cache's exact lexical owner. Following a symlink or accepting
  // an uncached path could unregister a database another process now owns.
  const resolvedPath = path.resolve(pathname);
  const database = cachedDatabases.get(resolvedPath);
  if (!database || database.path !== resolvedPath) {
    return false;
  }
  try {
    unregisterOpenClawAgentDatabase({
      agentId: database.agentId,
      path: resolvedPath,
      ...(options.env ? { env: options.env } : {}),
    });
  } finally {
    // Secret-bearing transient DBs must close even when registry maintenance
    // fails; Windows otherwise cannot remove the file during caller cleanup.
    closeOpenClawAgentDatabaseByPath(resolvedPath);
  }
  return true;
}

/** Close all cached agent database handles. */
export function closeOpenClawAgentDatabases(): void {
  unregisterExitClose?.();
  unregisterExitClose = null;
  for (const database of cachedDatabases.values()) {
    closeCachedOpenClawAgentDatabase(database);
  }
  cachedDatabases.clear();
}

/** Close cached agent handles and clear terminal failure latches for test isolation. */
export function closeOpenClawAgentDatabasesForTest(): void {
  closeOpenClawAgentDatabases();
  terminalOpenLatch.clearAll();
}
