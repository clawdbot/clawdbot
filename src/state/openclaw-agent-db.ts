// OpenClaw agent database stores agent-scoped persisted runtime state.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPathInside } from "../infra/path-guards.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import {
  deferSqlitePostCommitPublication,
  withSqlitePostCommitPublications,
} from "../infra/sqlite-post-commit.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseOwnerInspection,
} from "./openclaw-agent-db-contract.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
  runWithAgentDatabaseMaintenanceAuthority,
} from "./openclaw-agent-db-lease.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import {
  isSameOpenClawAgentDatabasePath,
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  assertAgentDatabaseIntegrityBeforeMutation,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import {
  clearOpenClawAgentDatabaseValidationCache,
  getValidatedOpenClawAgentDatabaseOwner,
  invalidateOpenClawAgentDatabaseValidation,
  setValidatedOpenClawAgentDatabaseOwner,
} from "./openclaw-agent-db-validation-cache.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import {
  createOpenClawDatabaseVerificationError,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

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
export {
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "./openclaw-agent-db-registry.js";
export { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
export {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

/**
 * Per-agent SQLite database lifecycle and shared-state registration.
 *
 * Each opened agent database is schema-owned by one normalized agent id, cached
 * per pathname, protected with private file modes, and registered in the shared
 * OpenClaw state database for discovery and maintenance.
 */
const OPENCLAW_AGENT_DB_SLOW_OPEN_MS = 1_000;

export class IncognitoAgentDatabasePathCollisionError extends Error {
  readonly path: string;

  constructor(pathname: string) {
    super(
      `Incognito agent database sentinel path already exists: ${pathname}. This filename is reserved for in-memory incognito state; move or rename the file and retry.`,
    );
    this.name = "IncognitoAgentDatabasePathCollisionError";
    this.path = pathname;
  }
}
// Target 64 cached handles (roughly three WAL FDs each). Live borrowers,
// transactions and incognito sessions keep their handles until owner release.
export const OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP = 64;
const agentDbLog = createSubsystemLogger("state/agent-db");
// Native and transformed SDK graphs must share the complete owner lifecycle;
// sharing only handles would split borrow pins, failure latches, and cleanup.
type AgentDatabaseLifecycle = {
  databases: Map<string, OpenClawAgentDatabase>;
  borrowers: WeakMap<DatabaseSync, Set<object>>;
  incognito: WeakSet<OpenClawAgentDatabase>;
  generation: number;
  failures: Map<string, unknown>;
  leases: Map<string, { leaseId: string; env: NodeJS.ProcessEnv }>;
  terminal: ReturnType<typeof createSqliteTerminalOpenLatch>;
  unregisterExitClose: (() => void) | null;
};
const cache = resolveGlobalSingleton<AgentDatabaseLifecycle>(
  Symbol.for("openclaw.agentDatabaseLifecycle"),
  () => ({
    databases: new Map(),
    borrowers: new WeakMap(),
    incognito: new WeakSet(),
    generation: 0,
    failures: new Map(),
    leases: new Map(),
    terminal: createSqliteTerminalOpenLatch({ closeByPath: closeOpenClawAgentDatabaseByPath }),
    unregisterExitClose: null,
  }),
);

/** Reconfirm an advisory worker failure on the live owner connection. */
export function confirmOpenClawAgentDatabaseIntegrity(
  pathname: string,
): SqliteIntegrityConfirmation {
  const resolvedPath = path.resolve(pathname);
  closeOpenClawAgentDatabaseByPath(resolvedPath);
  // Closing breaks process ownership of the pathname. A replacement must
  // revalidate and claim its schema before the path can become trusted again.
  invalidateOpenClawAgentDatabaseValidation(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawAgentDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  const recorded = cache.terminal.record(pathname, error, generation);
  if (recorded) {
    // Quarantine revokes this process's trust because doctor may replace the file.
    invalidateOpenClawAgentDatabaseValidation(pathname);
  }
  return recorded;
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
  cache.terminal.clear(resolvedPath);
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
  let db: DatabaseSync | undefined;
  try {
    // A handle this process holds was owner-validated when it was opened, and
    // ownership never changes afterwards. Answering from it keeps store
    // resolution off a fresh connection for every row it inspects.
    const opened = cache.databases.get(path.resolve(pathname));
    if (opened?.db.isOpen) {
      assertSupportedAgentSchemaVersion(opened.db, pathname);
      return { status: "owned", agentId: opened.agentId };
    }
    db = openNodeSqliteDatabase(pathname, { readOnly: true });
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
  const incognito = isIncognitoOpenClawAgentSqlitePath(pathname, databaseOptions);
  // A live successful cache entry is authoritative; failed entries remain only for disposal.
  const opened = getOpenClawAgentDatabaseIfOpen(databaseOptions);
  if (opened) {
    cache.databases.delete(pathname);
    cache.databases.set(pathname, opened);
    return opened;
  }
  const cached = cache.databases.get(pathname);
  if (incognito) {
    // The sentinel has no reachable durable owner, so doctor cannot safely migrate a collision.
    // Refuse operator-created state instead of silently shadowing it with volatile writes.
    if (existsSync(pathname)) {
      throw new IncognitoAgentDatabasePathCollisionError(pathname);
    }
    if (cached) {
      closeCachedOpenClawAgentDatabase(cached);
      cache.databases.delete(pathname);
      cache.failures.delete(pathname);
    }
    // After the collision probe, this sentinel is only a cache key: SQLite opens :memory:,
    // and no directory, lease, registry row, WAL sidecar, or file write may be created.
    const db = openNodeSqliteDatabase(":memory:", { allowExtension: !process.permission });
    db.enableLoadExtension(false);
    configureSqlitePreSchemaPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    });
    const walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: `openclaw-agent-incognito:${agentId}`,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    ensureOpenClawAgentSchema(db, agentId, pathname);
    const database = { agentId, db, path: pathname, walMaintenance };
    cache.incognito.add(database);
    cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    cache.databases.set(pathname, database);
    cache.generation += 1;
    return database;
  }
  quarantineOrphanedSqliteSidecars(pathname);
  // Latched paths are quarantined; every fresh open fails fast here until
  // doctor repairs the file and clears the latch plus the persisted row.
  const terminalFailure = cache.terminal.get(pathname);
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
    closeCachedOpenClawAgentDatabase(cached);
    cache.databases.delete(pathname);
    cache.failures.delete(pathname);
  }
  // Lease release must retain its original state owner after ambient env changes.
  const leaseEnvironment = {
    OPENCLAW_STATE_DIR: resolveStateDir(options.env ?? process.env),
    ...(isGatewayExternallySupervised(options.env ?? process.env)
      ? { OPENCLAW_SUPERVISOR_MODE: "external" }
      : {}),
  };
  const leaseId = claimOpenClawAgentDatabaseLease({
    agentId,
    path: pathname,
    env: leaseEnvironment,
  });
  const openStartedAt = Date.now();
  let openedDb: DatabaseSync | undefined;
  let openedDatabase: OpenClawAgentDatabase | undefined;
  let openedWalMaintenance: SqliteWalMaintenance | undefined;
  try {
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    // Free a slot before constructing the new handle: under real descriptor
    // pressure the 65th open would otherwise fail before eviction could run.
    evictLruAgentDatabaseHandles();
    // Node's permission model forbids extension-capable constructors. Otherwise,
    // trusted borrowers load native extensions only in synchronous sections.
    const db = openNodeSqliteDatabase(pathname, { allowExtension: !process.permission });
    db.enableLoadExtension(false);
    enableNodeSqliteKyselyStatementCache(db);
    openedDb = db;
    // Eviction churn must avoid migration/convergence and registry busy waits.
    // Version and owner can change while evicted, so their read-only gates run on every open.
    let isValidatedReopen = getValidatedOpenClawAgentDatabaseOwner(pathname) === agentId;
    const walMaintenance = (() => {
      let maintenance: OpenClawAgentDatabase["walMaintenance"] | undefined;
      try {
        db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
        assertSupportedAgentSchemaVersion(db, pathname);
        const existingSchema = readExistingAgentSchemaMeta(db);
        assertExistingAgentSchemaOwner(existingSchema, agentId, pathname);
        // Integrity is not process-stable: the file can be damaged while evicted.
        // This guard is read-only (no busy waits), so every physical open pays it.
        const requiresCurrentVersionConvergence = assertAgentDatabaseIntegrityBeforeMutation(
          db,
          agentId,
          pathname,
        );
        if (isValidatedReopen && (!existingSchema || requiresCurrentVersionConvergence)) {
          // New files and same-version divergence cannot inherit an earlier validation.
          // The existing full path initializes or converges them before exposure.
          invalidateOpenClawAgentDatabaseValidation(pathname);
          isValidatedReopen = false;
        }
        assertCanonicalAgentPersistenceVersion(db, pathname);
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
        openedWalMaintenance = maintenance;
        if (!isValidatedReopen) {
          ensureOpenClawAgentSchema(db, agentId, pathname);
        }
        return maintenance;
      } catch (err) {
        maintenance?.close();
        db.close();
        invalidateOpenClawAgentDatabaseValidation(pathname);
        if (
          err instanceof Error &&
          (isSqliteSchemaVersionError(err) || isTerminalSqliteIntegrityError(err))
        ) {
          recordOpenClawAgentDatabaseOpenFailure(pathname, err);
        }
        throw err;
      }
    })();
    ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
    const database = { agentId, db, path: pathname, walMaintenance };
    openedDatabase = database;
    if (!isValidatedReopen) {
      registerOpenClawAgentDatabase({ agentId, path: pathname, env: options.env });
      setValidatedOpenClawAgentDatabaseOwner(pathname, agentId);
    }
    cache.terminal.clear(pathname);
    // Safety net for processes that end without an orderly close: agent DBs have
    // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
    cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    logSlowAgentDatabaseOpen({
      agentId,
      elapsedMs: Date.now() - openStartedAt,
      path: pathname,
    });
    cache.leases.set(pathname, { leaseId, env: leaseEnvironment });
    cache.databases.set(pathname, database);
    return database;
  } catch (error) {
    let closeError: unknown;
    if (openedDatabase) {
      try {
        closeCachedOpenClawAgentDatabase(openedDatabase);
      } catch (caught) {
        closeError = caught;
      }
    }
    if (openedDb?.isOpen) {
      invalidateOpenClawAgentDatabaseValidation(pathname);
      const retainedDatabase =
        openedDatabase ??
        ({
          agentId,
          db: openedDb,
          path: pathname,
          walMaintenance: openedWalMaintenance ?? {
            checkpoint: () => false,
            close: () => false,
          },
        } satisfies OpenClawAgentDatabase);
      // Failed opens remain disposal-owned but cannot become successful cache hits.
      cache.databases.set(pathname, retainedDatabase);
      cache.leases.set(pathname, { leaseId, env: leaseEnvironment });
      cache.failures.set(pathname, closeError ?? error);
      cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    } else {
      releaseOpenClawAgentDatabaseLease(leaseId, { env: leaseEnvironment });
    }
    throw closeError ?? error;
  }
}

/** Queue a non-throwing runtime publication on the outer database commit edge. */
export function deferOpenClawAgentPostCommitPublication(
  database: OpenClawAgentDatabase,
  publish: () => void,
): boolean {
  return deferSqlitePostCommitPublication(database.db, publish);
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
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteImmediateTransactionSync(
      database.db,
      () => {
        const operationResult = operation(database);
        if (!enteredNestedTransaction) {
          // Permission failure must roll back with the write. Repairing after
          // COMMIT could make callers retry a transaction already durable in SQLite.
          if (!cache.incognito.has(database)) {
            ensureOpenClawAgentDatabasePermissions(database.path, options);
          }
        }
        return operationResult;
      },
      {
        busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
      },
    ),
  );
}

/** Retain the exact verified connection across awaits; explicit disposal still revokes it. */
export function borrowOpenClawAgentDatabase(options: OpenClawAgentDatabaseOptions): {
  db: DatabaseSync;
  release: () => void;
} {
  const { db } = openOpenClawAgentDatabase(options);
  const borrowers = cache.borrowers.get(db) ?? new Set<object>();
  const borrower = {};
  borrowers.add(borrower);
  cache.borrowers.set(db, borrowers);
  return {
    db,
    release: () => {
      borrowers.delete(borrower);
    },
  };
}

function closeCachedOpenClawAgentDatabase(
  database: OpenClawAgentDatabase,
  options: { eviction?: boolean } = {},
): void {
  // Eviction must stay cheap: PASSIVE skips waiting on concurrent readers,
  // whose drained TRUNCATE checkpoints blocked the event loop for seconds.
  database.walMaintenance.close(options.eviction ? { checkpointMode: "PASSIVE" } : undefined);
  if (database.db.isOpen) {
    database.db.close();
  }
  const lease = cache.leases.get(database.path);
  if (lease) {
    releaseOpenClawAgentDatabaseLease(lease.leaseId, { env: lease.env });
    cache.leases.delete(database.path);
  }
}

function evictLruAgentDatabaseHandles(): void {
  // Synchronous callers re-fetch at operation entry. Borrowers retain the exact
  // connection across awaits, including prepared statements and loaded extensions.
  while (cache.databases.size >= OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP) {
    let evicted = false;
    for (const [pathname, database] of cache.databases) {
      // Failed lease release can leave a closed handle cached; retry its cleanup
      // before reading isTransaction, which rejects closed handles. Incognito
      // identity was recorded at open, including explicit-env sentinel paths.
      if (
        database.db.isOpen &&
        (database.db.isTransaction ||
          cache.borrowers.get(database.db)?.size ||
          cache.incognito.has(database))
      ) {
        continue;
      }
      // Registry rows are durable discovery metadata; only explicit disposal
      // unregisters them, while eviction closes this process-local handle.
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      cache.databases.delete(pathname);
      cache.failures.delete(pathname);
      if (cache.incognito.has(database)) {
        cache.generation += 1;
      }
      agentDbLog.debug("evicted OpenClaw agent database handle", {
        agentId: database.agentId,
        openHandles: cache.databases.size,
        path: pathname,
      });
      evicted = true;
      break;
    }
    if (!evicted) {
      // Live borrows, incognito state, and transactions cannot be evicted.
      // Their owners release them; an unrelated agent must still be able to open.
      agentDbLog.warn("agent database handle cap exceeded; all cached handles are retained", {
        cap: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
        openHandles: cache.databases.size,
      });
      return;
    }
  }
}

/** Return whether the exact cached agent database pathname is still open. */
export function isOpenClawAgentDatabaseOpen(pathname: string): boolean {
  const database = cache.databases.get(path.resolve(pathname));
  return database?.db.isOpen === true;
}

/** Return the matching live cache entry without materializing a database. */
export function getOpenClawAgentDatabaseIfOpen(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  const database = cache.databases.get(pathname);
  if (!database?.db.isOpen) {
    return undefined;
  }
  if (cache.failures.has(pathname)) {
    throw cache.failures.get(pathname);
  }
  if (database.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} is already open for agent ${database.agentId}; requested agent ${agentId}.`,
    );
  }
  return database;
}

/** Lists process-held incognito databases without opening new sentinel handles. */
export function listOpenIncognitoAgentDatabases(): Array<{ agentId: string; storePath: string }> {
  return [...cache.databases.values()]
    .filter((database) => database.db.isOpen && cache.incognito.has(database))
    .map((database) => ({ agentId: database.agentId, storePath: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.storePath.localeCompare(right.storePath),
    );
}

/** Return the generation of process-held incognito database membership. */
export function readOpenIncognitoAgentDatabaseGeneration(): number {
  return cache.generation;
}

/** Returns whether this exact process-held database is incognito/in-memory. */
export function isIncognitoOpenClawAgentDatabase(database: OpenClawAgentDatabase): boolean {
  return cache.incognito.has(database);
}

/** List process-held agent databases without opening or inspecting fixture state. */
export function listOpenClawAgentDatabasesForTest(): Array<{ agentId: string; path: string }> {
  return [...cache.databases.values()]
    .filter((database) => database.db.isOpen)
    .map((database) => ({ agentId: database.agentId, path: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.path.localeCompare(right.path),
    );
}

/** Close one cached agent database identified by its exact resolved pathname. */
export function closeOpenClawAgentDatabaseByPath(pathname: string): boolean {
  // Cache keys are lexical resolved paths. Do not realpath aliases here: a
  // symlink swap must never redirect cleanup onto a different cached database.
  const resolvedPath = path.resolve(pathname);
  const database = cache.databases.get(resolvedPath);
  if (!database) {
    return false;
  }
  const incognito = cache.incognito.has(database);
  closeCachedOpenClawAgentDatabase(database);
  cache.databases.delete(resolvedPath);
  cache.failures.delete(resolvedPath);
  if (incognito) {
    cache.generation += 1;
  }
  if (cache.databases.size === 0) {
    cache.unregisterExitClose?.();
    cache.unregisterExitClose = null;
  }
  return true;
}

export type OpenClawAgentDatabaseWorkerCloseResult = {
  errors: Error[];
  settled: boolean;
};

/**
 * Converge a terminating worker's cached handle and durable lease without
 * turning an already committed worker result into an operation failure.
 * Callers own a bounded retry policy and must surface an unsettled result.
 */
export function settleOpenClawAgentDatabaseWorkerClose(
  pathname: string,
): OpenClawAgentDatabaseWorkerCloseResult {
  const resolvedPath = path.resolve(pathname);
  const errors: Error[] = [];
  const database = cache.databases.get(resolvedPath);
  if (database) {
    try {
      database.walMaintenance.close();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (database.db.isOpen) {
      try {
        database.db.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!database.db.isOpen) {
      const incognito = cache.incognito.has(database);
      cache.databases.delete(resolvedPath);
      cache.failures.delete(resolvedPath);
      if (incognito) {
        cache.generation += 1;
      }
      if (cache.databases.size === 0) {
        cache.unregisterExitClose?.();
        cache.unregisterExitClose = null;
      }
    }
  }

  if (!cache.databases.get(resolvedPath)?.db.isOpen) {
    const lease = cache.leases.get(resolvedPath);
    if (lease) {
      try {
        releaseOpenClawAgentDatabaseLease(lease.leaseId, { env: lease.env });
        cache.leases.delete(resolvedPath);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return {
    errors,
    settled: !cache.databases.get(resolvedPath)?.db.isOpen && !cache.leases.has(resolvedPath),
  };
}

/** Close and unregister one unambiguous transient agent database by filesystem identity. */
export function disposeOpenClawAgentDatabaseByPath(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  // Disposal can be followed by file deletion or recreation, so revalidate next open.
  invalidateOpenClawAgentDatabaseValidation(resolvedPath);
  const matchingDatabases = [...cache.databases.values()].filter((candidate) =>
    isSameOpenClawAgentDatabasePath(candidate.path, resolvedPath),
  );
  if (matchingDatabases.length > 1) {
    return false;
  }
  const database = matchingDatabases[0];
  if (database && cache.incognito.has(database)) {
    return closeOpenClawAgentDatabaseByPath(database.path);
  }
  if (!database) {
    return false;
  }
  try {
    unregisterOpenClawAgentDatabase({
      agentId: database.agentId,
      path: database.path,
      ...(options.env ? { env: options.env } : {}),
    });
  } finally {
    // Secret-bearing transient DBs must close even when registry maintenance
    // fails; Windows otherwise cannot remove the file during caller cleanup.
    closeOpenClawAgentDatabaseByPath(database.path);
  }
  return true;
}

/** Close cached agent handles, optionally restricted to one runtime root. */
export function closeOpenClawAgentDatabases(rootPath?: string): void {
  for (const pathname of cache.databases.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      closeOpenClawAgentDatabaseByPath(pathname);
    }
  }
}

/** Fence cross-process agent writers while Doctor reconciles shared plugin state. */
export function withAgentDatabaseMaintenanceLease<T>(
  options: Pick<OpenClawStateDatabaseOptions, "env">,
  run: (maintenance: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  return withOpenClawStateLease(
    {
      ...AGENT_DATABASE_MAINTENANCE_LEASE,
      database: { scope: "shared", options },
      leaseMs: 60_000,
      waitMs: 5_000,
      heartbeat: "worker",
      leaseLabel: "agent database maintenance lease",
      operationLabel: "agent.database.maintenance.lease",
    },
    (maintenance) => {
      // Claiming first closes the cross-process gap: every later writer claim
      // observes this same lease inside its authoritative state transaction.
      closeOpenClawAgentDatabases();
      assertNoOpenClawAgentDatabaseLeases(maintenance, options);
      return runWithAgentDatabaseMaintenanceAuthority(maintenance, () => run(maintenance));
    },
  );
}

/** Release fixture handles and pathname trust before a test root is recreated. */
export function closeOpenClawAgentDatabasesForTest(rootPath?: string): void {
  closeOpenClawAgentDatabases(rootPath);
  clearOpenClawAgentDatabaseValidationCache(rootPath);
  cache.terminal.clearAll(rootPath);
}
