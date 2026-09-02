// OpenClaw agent database stores agent-scoped persisted runtime state.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
// Each WAL database consumes roughly three file descriptors, so the fixed cap
// satisfies the bounded-cache policy within a predictable FD budget, without config.
export const OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP = 64;
const agentDbLog = createSubsystemLogger("state/agent-db");
const cachedDatabases = new Map<string, OpenClawAgentDatabase>();
const incognitoDatabases = new WeakSet<OpenClawAgentDatabase>();
let incognitoDatabaseGeneration = 0;
const cachedDatabaseOpenFailures = new Map<string, unknown>();
const cachedDatabaseLeases = new Map<
  string,
  { leaseId: string; env: NodeJS.ProcessEnv | undefined }
>();
// External schema changes under a live process are unsupported: doctor migrations
// require restart, so successful owner/schema validation is process-stable.
const validatedAgentDatabasePaths = new Map<string, string>();
const terminalOpenLatch = createSqliteTerminalOpenLatch({
  closeByPath: closeOpenClawAgentDatabaseByPath,
});

/** Reconfirm an advisory worker failure on the live owner connection. */
export function confirmOpenClawAgentDatabaseIntegrity(
  pathname: string,
): SqliteIntegrityConfirmation {
  const resolvedPath = path.resolve(pathname);
  closeOpenClawAgentDatabaseByPath(resolvedPath);
  // Closing breaks process ownership of the pathname. A replacement must
  // revalidate and claim its schema before the path can become trusted again.
  validatedAgentDatabasePaths.delete(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawAgentDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  const recorded = terminalOpenLatch.record(pathname, error, generation);
  if (recorded) {
    // Quarantine revokes this process's trust because doctor may replace the file.
    validatedAgentDatabasePaths.delete(path.resolve(pathname));
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
  let db: DatabaseSync | undefined;
  try {
    // A handle this process holds was owner-validated when it was opened, and
    // ownership never changes afterwards. Answering from it keeps store
    // resolution off a fresh connection for every row it inspects.
    const opened = cachedDatabases.get(path.resolve(pathname));
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
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    if (cachedDatabaseOpenFailures.has(pathname)) {
      throw cachedDatabaseOpenFailures.get(pathname);
    }
    if (cached.agentId !== agentId) {
      throw new Error(
        `OpenClaw agent database ${pathname} is already open for agent ${cached.agentId}; requested agent ${agentId}.`,
      );
    }
    cachedDatabases.delete(pathname);
    cachedDatabases.set(pathname, cached);
    return cached;
  }
  if (incognito) {
    // The sentinel has no reachable durable owner, so doctor cannot safely migrate a collision.
    // Refuse operator-created state instead of silently shadowing it with volatile writes.
    if (existsSync(pathname)) {
      throw new IncognitoAgentDatabasePathCollisionError(pathname);
    }
    if (cached) {
      closeCachedOpenClawAgentDatabase(cached);
      cachedDatabases.delete(pathname);
      cachedDatabaseOpenFailures.delete(pathname);
    }
    // After the collision probe, this sentinel is only a cache key: SQLite opens :memory:,
    // and no directory, lease, registry row, WAL sidecar, or file write may be created.
    const db = openNodeSqliteDatabase(":memory:");
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
    incognitoDatabases.add(database);
    unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    cachedDatabases.set(pathname, database);
    incognitoDatabaseGeneration += 1;
    return database;
  }
  quarantineOrphanedSqliteSidecars(pathname);
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
    closeCachedOpenClawAgentDatabase(cached);
    cachedDatabases.delete(pathname);
    cachedDatabaseOpenFailures.delete(pathname);
  }
  const leaseId = claimOpenClawAgentDatabaseLease({
    agentId,
    path: pathname,
    ...(options.env ? { env: options.env } : {}),
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
    const db = openNodeSqliteDatabase(pathname);
    enableNodeSqliteKyselyStatementCache(db);
    openedDb = db;
    // Eviction churn must avoid migration/convergence and registry busy waits.
    // Version and owner can change while evicted, so their read-only gates run on every open.
    let isValidatedReopen = validatedAgentDatabasePaths.get(pathname) === agentId;
    const walMaintenance = (() => {
      let maintenance: OpenClawAgentDatabase["walMaintenance"] | undefined;
      try {
        db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
        assertSupportedAgentSchemaVersion(db, pathname);
        assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
        // Integrity is not process-stable: the file can be damaged while evicted.
        // This guard is read-only (no busy waits), so every physical open pays it.
        const requiresCurrentVersionConvergence = assertAgentDatabaseIntegrityBeforeMutation(
          db,
          agentId,
          pathname,
        );
        if (isValidatedReopen && requiresCurrentVersionConvergence) {
          // Same-version replacement can preserve owner/version while dropping additive schema.
          // Demote trust so the existing full path repairs atomically before exposure.
          validatedAgentDatabasePaths.delete(pathname);
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
        validatedAgentDatabasePaths.delete(pathname);
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
      validatedAgentDatabasePaths.set(pathname, agentId);
    }
    terminalOpenLatch.clear(pathname);
    // Safety net for processes that end without an orderly close: agent DBs have
    // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
    unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    logSlowAgentDatabaseOpen({
      agentId,
      elapsedMs: Date.now() - openStartedAt,
      path: pathname,
    });
    cachedDatabaseLeases.set(pathname, { leaseId, env: options.env });
    cachedDatabases.set(pathname, database);
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
      validatedAgentDatabasePaths.delete(pathname);
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
      cachedDatabases.set(pathname, retainedDatabase);
      cachedDatabaseLeases.set(pathname, { leaseId, env: options.env });
      cachedDatabaseOpenFailures.set(pathname, closeError ?? error);
      unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
    } else {
      releaseOpenClawAgentDatabaseLease(leaseId, { env: options.env });
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
          if (!incognitoDatabases.has(database)) {
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

let unregisterExitClose: (() => void) | null = null;

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
  const lease = cachedDatabaseLeases.get(database.path);
  if (lease) {
    releaseOpenClawAgentDatabaseLease(lease.leaseId, { env: lease.env });
    cachedDatabaseLeases.delete(database.path);
  }
}

function evictLruAgentDatabaseHandles(): void {
  // Callers re-fetch handles from this cache at each operation entry and use
  // them within one synchronous section, so eviction can never close a handle
  // mid-use; a handle retained across an eviction-triggering open goes stale.
  while (cachedDatabases.size >= OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP) {
    let evicted = false;
    for (const [pathname, database] of cachedDatabases) {
      // A synchronous transaction owns its handle through COMMIT or ROLLBACK;
      // closing it here would violate the transaction commit-section contract.
      if (database.db.isTransaction) {
        continue;
      }
      // Classification is recorded at open; re-deriving the sentinel path here
      // would consult process.env and can misclassify explicit-env opens,
      // letting LRU eviction destroy a live in-memory incognito session.
      if (incognitoDatabases.has(database)) {
        continue;
      }
      // Registry rows are durable discovery metadata; only explicit disposal
      // unregisters them, while eviction closes this process-local handle.
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      cachedDatabases.delete(pathname);
      cachedDatabaseOpenFailures.delete(pathname);
      agentDbLog.debug("evicted OpenClaw agent database handle", {
        agentId: database.agentId,
        openHandles: cachedDatabases.size,
        path: pathname,
      });
      evicted = true;
      break;
    }
    if (!evicted) {
      // Every handle is mid-transaction: sync commit sections bound concurrent
      // transactions at call-nesting depth, so this stays a pathological safety
      // valve; exceeding the cap beats failing an unrelated agent's open.
      agentDbLog.warn(
        "agent database handle cap exceeded; all cached handles are in transactions",
        {
          cap: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
          openHandles: cachedDatabases.size,
        },
      );
      return;
    }
  }
}

/** Return whether the exact cached agent database pathname is still open. */
export function isOpenClawAgentDatabaseOpen(pathname: string): boolean {
  const database = cachedDatabases.get(path.resolve(pathname));
  return database?.db.isOpen === true;
}

/** Return the matching live cache entry without materializing a database. */
export function getOpenClawAgentDatabaseIfOpen(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  const database = cachedDatabases.get(pathname);
  if (!database?.db.isOpen) {
    return undefined;
  }
  if (cachedDatabaseOpenFailures.has(pathname)) {
    throw cachedDatabaseOpenFailures.get(pathname);
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
  return [...cachedDatabases.values()]
    .filter((database) => database.db.isOpen && incognitoDatabases.has(database))
    .map((database) => ({ agentId: database.agentId, storePath: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.storePath.localeCompare(right.storePath),
    );
}

/** Return the generation of process-held incognito database membership. */
export function readOpenIncognitoAgentDatabaseGeneration(): number {
  return incognitoDatabaseGeneration;
}

/** Returns whether this exact process-held database is incognito/in-memory. */
export function isIncognitoOpenClawAgentDatabase(database: OpenClawAgentDatabase): boolean {
  return incognitoDatabases.has(database);
}

/** List process-held agent databases without opening or inspecting fixture state. */
export function listOpenClawAgentDatabasesForTest(): Array<{ agentId: string; path: string }> {
  return [...cachedDatabases.values()]
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
  const database = cachedDatabases.get(resolvedPath);
  if (!database) {
    return false;
  }
  const incognito = incognitoDatabases.has(database);
  closeCachedOpenClawAgentDatabase(database);
  cachedDatabases.delete(resolvedPath);
  cachedDatabaseOpenFailures.delete(resolvedPath);
  if (incognito) {
    incognitoDatabaseGeneration += 1;
  }
  if (cachedDatabases.size === 0) {
    unregisterExitClose?.();
    unregisterExitClose = null;
  }
  return true;
}

/** Close and unregister one unambiguous transient agent database by filesystem identity. */
export function disposeOpenClawAgentDatabaseByPath(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  // Disposal can be followed by file deletion or recreation, so revalidate next open.
  validatedAgentDatabasePaths.delete(resolvedPath);
  const matchingDatabases = [...cachedDatabases.values()].filter((candidate) =>
    isSameOpenClawAgentDatabasePath(candidate.path, resolvedPath),
  );
  if (matchingDatabases.length > 1) {
    return false;
  }
  const database = matchingDatabases[0];
  if (database && incognitoDatabases.has(database)) {
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
  for (const pathname of cachedDatabases.keys()) {
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

/** Close cached agent handles and clear terminal failure latches for test isolation. */
export function closeOpenClawAgentDatabasesForTest(): void {
  closeOpenClawAgentDatabases();
  validatedAgentDatabasePaths.clear();
  terminalOpenLatch.clearAll();
}
