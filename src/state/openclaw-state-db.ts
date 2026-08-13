// OpenClaw state database manages shared persisted state and migrations.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { assertSqliteSchemaTablesPresent } from "../infra/sqlite-schema-contract.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import {
  isSqliteCorruptionError,
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VERSION } from "../version.js";
import { clearOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import { openClawStateDatabaseCache as stateDbCache } from "./openclaw-state-db-cache.js";
export { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  assertOpenClawStateDatabaseV5ForMigration,
  assertOpenClawStateDatabaseV6ForMigration,
  assertSupportedSchemaVersion,
  resolveDatabasePath,
} from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { ensureAdditiveStateColumns } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  assertCanonicalStateSchemaShape,
  detectOpenClawStateDatabaseSchemaMigrationsFromDatabase,
  dropLegacyStateTables,
  markCurrentStateSchemaVersion,
  migrateRetiredCommitmentsSchema,
  repairAgentDatabasesCompositePrimaryKey,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./openclaw-state-db-schema-repair.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  assertOpenClawStateWriteAllowed,
  OpenClawStateOwnershipError,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const STATE_MIGRATION_ASSERTIONS = {
  5: assertOpenClawStateDatabaseV5ForMigration,
  6: assertOpenClawStateDatabaseV6ForMigration,
} as const;

export {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
};
export type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
export {
  assertOpenClawStateDatabaseForMaintenance,
  createOpenClawDatabaseVerificationError,
} from "./openclaw-state-db-maintenance.js";
export { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
export { detectOpenClawStateDatabaseSchemaMigrations } from "./openclaw-state-db-schema-repair.js";
export { withOpenClawStateStartupMigrationCheckpointDatabase } from "./openclaw-state-db-startup-checkpoint.js";

/** Reconfirm an advisory worker failure on the live owner connection. */
export function confirmOpenClawStateDatabaseIntegrity(
  pathname: string,
): SqliteIntegrityConfirmation {
  const resolvedPath = path.resolve(pathname);
  closeOpenClawStateDatabaseByPath(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawStateDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  return stateDbCache.recordOpenClawStateDatabaseOpenFailure(pathname, error, generation);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
export function clearOpenClawStateDatabaseOpenFailure(pathname: string): void {
  stateDbCache.clearOpenClawStateDatabaseOpenFailure(pathname);
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
export function assertOpenClawStateDatabaseFreshOpenAllowed(
  options: OpenClawStateDatabaseOptions = {},
): void {
  const env = options.env ?? process.env;
  stateDbCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(resolveDatabasePath(options), env);
}

type OpenClawStateMetadataDatabase = Pick<OpenClawStateKyselyDatabase, "schema_meta">;
const stateDbLog = createSubsystemLogger("state/db");

function executeCanonicalStateSchema(
  database: DatabaseSync,
  options: { includeVersionLazyAdditiveTables: boolean },
): void {
  database.exec(getOpenClawStateRuntimeSchema(options));
}

function repairOpenClawStateDatabaseSchemaWithWriteAccess(
  pathname: string,
  env: NodeJS.ProcessEnv,
): {
  changes: string[];
  warnings: string[];
} {
  ensureOpenClawStatePermissions(pathname, env);
  const db = openNodeSqliteDatabase(pathname);
  const rebuiltIndexNames = new Set<string>();
  let ownershipRefused = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedSchemaVersion(db, pathname);
    db.exec("PRAGMA foreign_keys = OFF;");
    const changes = runSqliteImmediateTransactionSync(
      db,
      () => {
        assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
        const applied: string[] = [];
        const previousVersion = readSqliteUserVersion(db);
        if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          for (const name of repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            allowMissingColumns: true,
          })) {
            rebuiltIndexNames.add(name);
          }
          // Current-schema doctor repair may normalize recognized columns or
          // table options, but it must never recreate a missing table empty.
          assertSqliteSchemaTablesPresent(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            allowedMissingTables: LAZY_ADDITIVE_STATE_TABLES,
          });
        } else if (previousVersion === 5 || previousVersion === 6) {
          STATE_MIGRATION_ASSERTIONS[previousVersion](db, { pathname });
        }
        if (rebuiltIndexNames.size === 0) {
          assertSqliteIntegrity(db, pathname);
        }
        dropLegacyStateTables(db);
        if (migrateRetiredCommitmentsSchema(db, previousVersion)) {
          applied.push("Retired shared state commitments table and indexes");
        }
        if (repairAgentDatabasesCompositePrimaryKey(db)) {
          applied.push(`Migrated shared state agent database registry primary key → agent_id,path`);
        }
        if (repairAuditEventsSchema(db)) {
          applied.push(
            `Migrated shared state audit event ledger → versioned message lifecycle schema`,
          );
        }
        applied.push(...operatorApprovalMigration.repairOperatorApprovalSchema(db));
        const needsSessionWatchMigration =
          sessionWatchMigration.needsSessionWatchCursorProvenanceMigration(db, previousVersion);
        const sessionWatchResult = sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        if (needsSessionWatchMigration) {
          applied.push(
            `Migrated shared state session watch cursors → provenance column (${sessionWatchResult.migratedAmbientWatches} ambient, ${sessionWatchResult.removedLegacySentinels} sentinels removed)`,
          );
        }
        assertCanonicalStateSchemaShape(db, pathname);
        if (tableExists(db, "audit_events")) {
          ensureAdditiveStateColumns(db);
          executeCanonicalStateSchema(db, {
            includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
          });
          if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
          }
          const strictMigration = migrateSqliteSchemaToStrictInTransaction(
            db,
            getOpenClawStateRuntimeSchema({
              includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
            }),
            { databaseLabel: pathname },
          );
          if (strictMigration.migratedTables.length > 0) {
            applied.push(
              `Migrated shared state tables to SQLite STRICT typing (${strictMigration.migratedTables.length})`,
            );
          }
          for (const name of repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            verifyPhysicalIntegrity: false,
          })) {
            rebuiltIndexNames.add(name);
          }
        }
        markCurrentStateSchemaVersion(db, {
          createMetadataIfMissing: previousVersion < OPENCLAW_STATE_SCHEMA_VERSION,
        });
        if (readSqliteUserVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
          assertCurrentStateRuntimeSchema(db, pathname);
        }
        if (rebuiltIndexNames.size > 0) {
          applied.push(`Rebuilt canonical shared-state SQLite indexes (${rebuiltIndexNames.size})`);
        }
        return applied;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.repair",
      },
    );
    const quarantineCleared = clearOpenClawDatabaseQuarantine(pathname, { env });
    clearOpenClawStateDatabaseOpenFailure(pathname);
    return {
      changes,
      warnings: quarantineCleared
        ? []
        : [
            `Persisted quarantine record for ${pathname} could not be cleared; rerun openclaw doctor --fix so the repaired database is not refused again.`,
          ],
    };
  } catch (err) {
    if (err instanceof OpenClawStateOwnershipError) {
      ownershipRefused = true;
      throw err;
    }
    // Reaching this catch inside doctor means repair itself refused or failed,
    // so the runtime asserts' "run openclaw doctor --fix" advice is circular here.
    const reason = String(err).replace(
      /has a legacy ([a-z ]+) schema; run openclaw doctor --fix to migrate it\./u,
      "has a legacy $1 schema; automatic repair refused the unrecognized schema shape.",
    );
    return {
      changes: [],
      warnings: [`Failed migrating shared state database schema at ${pathname}: ${reason}`],
    };
  } finally {
    if (db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    if (!ownershipRefused) {
      ensureOpenClawStatePermissions(pathname, env);
    }
  }
}

export function repairOpenClawStateDatabaseSchema(options: OpenClawStateDatabaseOptions = {}): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  return runWithOpenClawStateWriteAccess(
    { databasePath: pathname, env },
    "state schema repair",
    () => repairOpenClawStateDatabaseSchemaWithWriteAccess(pathname, env),
  );
}

function needsOpenClawStateDatabaseSchemaRepair(pathname: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(pathname, { readOnly: true });
    assertSupportedSchemaVersion(database, pathname);
    const needsRepair =
      readSqliteUserVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION ||
      detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(database, pathname).length > 0;
    if (!needsRepair) {
      assertCurrentStateRuntimeSchema(database, pathname);
    }
    return needsRepair;
  } catch {
    // Preserve the repair path's existing diagnostics for unreadable or noncanonical databases.
    return true;
  } finally {
    database?.close();
  }
}

/** Skip the exclusive doctor repair when automatic migration sees a canonical current schema. */
export function repairOpenClawStateDatabaseSchemaIfNeeded(
  options: OpenClawStateDatabaseOptions = {},
): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }

  return runWithOpenClawStateWriteAccess(
    { databasePath: pathname, env },
    "state schema repair preflight/repair",
    () =>
      needsOpenClawStateDatabaseSchemaRepair(pathname)
        ? repairOpenClawStateDatabaseSchemaWithWriteAccess(pathname, env)
        : { changes: [], warnings: [] },
  );
}

function ensureSchema(db: DatabaseSync, pathname: string, env: NodeJS.ProcessEnv): void {
  const now = Date.now();
  const kysely = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(db);
  // Rebuilding referenced tables requires disabling FK enforcement before BEGIN.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runSqliteImmediateTransactionSync(
      db,
      () => {
        // Recheck ownership after BEGIN IMMEDIATE so no current-schema repair
        // can race a durable external ownership claim.
        assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
        assertSupportedSchemaVersion(db, pathname);
        const previousVersion = readSqliteUserVersion(db);
        if (previousVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
          verifyAndRepairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
            allowMissingColumns: true,
            validateAfterRepair: () => assertCurrentStateRuntimeSchema(db, pathname),
          });
          ensureAdditiveStateColumns(db);
          assertCurrentStateRuntimeSchema(db, pathname);
        } else if (previousVersion === 5 || previousVersion === 6) {
          STATE_MIGRATION_ASSERTIONS[previousVersion](db, { pathname });
        }
        dropLegacyStateTables(db);
        migrateRetiredCommitmentsSchema(db, previousVersion);
        ensureAdditiveStateColumns(db);
        sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        assertCanonicalStateSchemaShape(db, pathname);
        executeCanonicalStateSchema(db, {
          includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
        });
        migrateLegacyCronRunLogsToTaskRuns(db);
        if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
          repairLegacyGatewayRestartHandoffsForStrictMigration(db);
          migrateSqliteSchemaToStrictInTransaction(
            db,
            getOpenClawStateRuntimeSchema({
              includeVersionLazyAdditiveTables: previousVersion !== OPENCLAW_STATE_SCHEMA_VERSION,
            }),
            { databaseLabel: pathname },
          );
        }
        repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
          verifyPhysicalIntegrity: false,
        });
        db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("schema_meta")
            .values({
              meta_key: "primary",
              role: "global",
              schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
              agent_id: null,
              app_version: VERSION,
              created_at: now,
              updated_at: now,
            })
            .onConflict((conflict) =>
              conflict
                .column("meta_key")
                .doUpdateSet({
                  role: "global",
                  schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
                  agent_id: null,
                  app_version: VERSION,
                  updated_at: now,
                })
                // updated_at records when schema metadata last changed, not when
                // the database was last opened; unconditional bumps make every
                // open dirty the row and defeat no-change backup detection.
                .where((eb) =>
                  eb.or([
                    eb("schema_meta.schema_version", "!=", OPENCLAW_STATE_SCHEMA_VERSION),
                    eb("schema_meta.app_version", "!=", VERSION),
                    eb("schema_meta.role", "!=", "global"),
                  ]),
                ),
            ),
        );
        assertOpenClawStateDatabaseForMaintenance(db, { pathname });
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.ensure",
      },
    );
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/** Open existing shared state without creating, migrating, chmodding, or configuring it. */
export async function openExistingOpenClawStateDatabaseReadOnly(
  options: OpenClawStateDatabaseOptions = {},
): Promise<OpenClawStateDatabase | undefined> {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return undefined;
  }
  assertOpenClawStateDatabaseFreshOpenAllowed(options);
  const prepared = await prepareSqliteReadOnlyLocation(pathname);
  let db: DatabaseSync;
  try {
    db = openNodeSqliteDatabase(prepared.location, {
      readOnly: true,
    });
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedSchemaVersion(db, pathname);
    assertSqliteIntegrity(db, pathname);
    if (readSqliteUserVersion(db) === OPENCLAW_STATE_SCHEMA_VERSION) {
      assertOpenClawStateDatabaseForMaintenance(db, { pathname });
    }
  } catch (error) {
    try {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    } catch {
      // Preserve the verification failure that explains why the database was refused.
    }
    prepared.cleanup();
    throw error;
  }
  let cleanupComplete = false;
  return {
    db,
    path: pathname,
    walMaintenance: {
      checkpoint: () => false,
      // Cleanup can fail transiently after the database closes. Keep the
      // close contract retryable until one call finishes both responsibilities.
      close: () => {
        const wasOpen = db.isOpen;
        if (!wasOpen && cleanupComplete) {
          return false;
        }
        try {
          if (wasOpen) {
            clearNodeSqliteKyselyCacheForDatabase(db);
            db.close();
          }
        } finally {
          cleanupComplete = prepared.cleanup();
        }
        return cleanupComplete;
      },
    },
  };
}

function assertCurrentStateRuntimeSchema(database: DatabaseSync, pathname: string): void {
  assertCanonicalStateSchemaShape(database, pathname);
  assertOpenClawStateDatabaseForMaintenance(database, { pathname });
}

function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  const migrationPending =
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < OPENCLAW_STATE_SCHEMA_VERSION);
  if (migrationPending) {
    stateDbLog.info("state database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  }
  if (userVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
    // Every physical open proves the full file before schema mutation or exposure.
    assertSqliteIntegrity(database, pathname);
  }
}

function openUnpublishedOpenClawStateDatabase(
  pathname: string,
  env: NodeJS.ProcessEnv,
): OpenClawStateDatabase {
  ensureOpenClawStatePermissions(pathname, env);
  const db = openNodeSqliteDatabase(pathname);
  enableNodeSqliteKyselyStatementCache(db);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
      db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
      assertSupportedSchemaVersion(db, pathname);
      assertStateDatabaseIntegrityBeforeMutation(db, pathname);
      configureSqlitePreSchemaPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "openclaw-state",
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureSchema(db, pathname, env);
      return maintenance;
    } catch (err) {
      maintenance?.close();
      db.close();
      if (
        err instanceof Error &&
        (err.name === "SqliteSchemaVersionError" || isTerminalSqliteIntegrityError(err))
      ) {
        recordOpenClawStateDatabaseOpenFailure(pathname, err);
      }
      throw err;
    }
  })();
  ensureOpenClawStatePermissions(pathname, env);
  return { db, path: pathname, walMaintenance };
}

/** Open or return a cached shared state database after schema and migration checks. */

export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  const env = options.env ?? process.env;
  if (options.database) {
    assertOpenClawStateWriteAllowed({
      database: options.database.db,
      databasePath: options.database.path,
      env,
    });
    return options.database;
  }
  const pathname = resolveDatabasePath(options);
  // Latched paths are quarantined: the recorder closed any live handle, and
  // every open fails fast here until doctor repairs the file and clears it.
  try {
    stateDbCache.assertOpenClawStateDatabaseOpenAllowed(pathname);
  } catch (error) {
    stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  const cached = stateDbCache.getCachedOpenClawStateDatabase(pathname);
  if (cached?.db.isOpen) {
    assertOpenClawStateWriteAllowed({ database: cached.db, databasePath: pathname, env });
    return cached;
  }
  try {
    assertOpenClawStateDatabaseFreshOpenAllowed(options);
  } catch (error) {
    stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  let unpublished: OpenClawStateDatabase | undefined;
  try {
    unpublished = runWithOpenClawStateWriteAccess(
      { databasePath: pathname, env },
      "fresh state database open",
      () => {
        if (cached) {
          // A closed handle can leave Kysely and WAL helpers cached; clear both under access.
          stateDbCache.closeStaleCachedOpenClawStateDatabase(cached);
        }
        return (unpublished = openUnpublishedOpenClawStateDatabase(pathname, env));
      },
    );
  } catch (error) {
    stateDbCache.recordOpenClawStateDatabaseLifecycleOpenError(pathname, error);
    if (!unpublished) {
      throw error;
    }
    const cleanup = stateDbCache.closeOpenClawStateDatabaseHandle(unpublished);
    if (cleanup.caught) {
      throw createSqliteLifecycleAggregateError(
        [error, ...cleanup.errors],
        `Fresh OpenClaw state database open failed releasing access and closing its unpublished handle for ${pathname}.`,
        error,
      );
    }
    throw error;
  }
  return stateDbCache.publishOpenClawStateDatabase(unpublished);
}

/** Run a synchronous immediate transaction against the shared state database. */
export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const cachedBeforeOpen = options.database ?? getOpenClawStateDatabaseIfOpen(options);
  let database: OpenClawStateDatabase;
  try {
    database = openOpenClawStateDatabase(options);
  } catch (error) {
    if (cachedBeforeOpen && isSqliteCorruptionError(error)) {
      stateDbCache.evictCachedOpenClawStateDatabase(cachedBeforeOpen);
    }
    throw error;
  }
  let result: T;
  try {
    result = runSqliteImmediateTransactionSync(
      database.db,
      () => {
        assertOpenClawStateWriteAllowed({
          database: database.db,
          databasePath: database.path,
          env: options.env ?? process.env,
        });
        return operation(database);
      },
      {
        busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "state.write",
      },
    );
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      stateDbCache.evictCachedOpenClawStateDatabase(database);
    }
    throw error;
  }
  try {
    ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
  } catch {
    // The write already committed; permission hardening is best-effort here so
    // callers never retry an operation that is durable in SQLite.
  }
  return result;
}

/**
 * Return a shared state handle this process already holds open, if any.
 *
 * Read-only callers use this to avoid opening a connection per call; it never
 * creates, repairs, or registers a handle.
 */
export function getOpenClawStateDatabaseIfOpen(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase | undefined {
  return stateDbCache.getOpenClawStateDatabaseIfOpenAtPath(resolveDatabasePath(options));
}

/** Evict an exact cached shared-state owner after a proven corruption read. */
export function evictOpenClawStateDatabaseAfterCorruption(
  database: OpenClawStateDatabase,
  error: unknown,
): boolean {
  return stateDbCache.evictOpenClawStateDatabaseAfterCorruption(database, error);
}

/** Close one cached shared state database handle by exact pathname. */
export function closeOpenClawStateDatabaseByPath(pathname: string): boolean {
  return stateDbCache.closeOpenClawStateDatabaseByPath(pathname);
}

/** Close all cached shared state database handles. */
export function closeOpenClawStateDatabase(): void {
  stateDbCache.closeOpenClawStateDatabase();
}

/** Test whether any cached shared state database handle is still open. */
export function isOpenClawStateDatabaseOpen(): boolean {
  return stateDbCache.isOpenClawStateDatabaseOpen();
}

/** Close shared state handles and clear terminal failure latches for test isolation. */
export function closeOpenClawStateDatabaseForTest(): void {
  stateDbCache.closeOpenClawStateDatabaseForTest();
}
