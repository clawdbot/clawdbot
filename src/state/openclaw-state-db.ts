// OpenClaw state database manages shared persisted state and migrations.
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  repairCanonicalSqliteUniqueIndexes,
  type CanonicalSqliteUniqueIndex,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import {
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
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  assertSupportedSchemaVersion,
  createOpenClawDatabaseVerificationError,
  resolveDatabasePath,
} from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { ensureAdditiveStateColumns } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  assertCanonicalStateSchemaShape,
  dropLegacyStateTables,
  markCurrentStateSchemaVersion,
  repairAgentDatabasesCompositePrimaryKey,
} from "./openclaw-state-db-schema-repair.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

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

/**
 * Shared OpenClaw SQLite state database lifecycle and metadata writers.
 *
 * This module owns schema creation, additive migrations for released state
 * tables, private file permissions, cached handles, and audit rows for
 * migrations/backups that operate on local state.
 */
const OPENCLAW_STATE_CANONICAL_UNIQUE_INDEXES = [
  {
    name: "idx_operator_approvals_resolution_ref",
    definition: "ON operator_approvals(resolution_ref)",
  },
  {
    name: "idx_worker_environments_provider_lease",
    definition: `
      ON worker_environments(provider_id, lease_id)
      WHERE lease_id IS NOT NULL
    `,
  },
] as const satisfies readonly CanonicalSqliteUniqueIndex[];

const cachedDatabases = new Map<string, OpenClawStateDatabase>();
const terminalOpenLatch = createSqliteTerminalOpenLatch({
  closeByPath: (pathname) => {
    const cached = cachedDatabases.get(pathname);
    if (!cached) {
      return;
    }
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    if (cached.db.isOpen) {
      cached.db.close();
    }
    cachedDatabases.delete(pathname);
  },
});

/** Latch background verification damage so later opens fail without rescanning. */
export function recordOpenClawStateDatabaseOpenFailure(pathname: string, error: Error): void {
  terminalOpenLatch.record(pathname, error);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
export function clearOpenClawStateDatabaseOpenFailure(pathname: string): void {
  terminalOpenLatch.clear(pathname);
}

type OpenClawStateMetadataDatabase = Pick<OpenClawStateKyselyDatabase, "schema_meta">;
const stateDbLog = createSubsystemLogger("state/db");

export function repairOpenClawStateDatabaseSchema(options: OpenClawStateDatabaseOptions = {}): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  try {
    assertSqliteIntegrity(db, pathname);
    assertSupportedSchemaVersion(db, pathname);
    db.exec("PRAGMA foreign_keys = OFF;");
    const changes = runSqliteImmediateTransactionSync(
      db,
      () => {
        const applied: string[] = [];
        const previousVersion = readSqliteUserVersion(db);
        dropLegacyStateTables(db);
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
          db.exec(OPENCLAW_STATE_SCHEMA_SQL);
          const strictMigration = migrateSqliteSchemaToStrictInTransaction(
            db,
            OPENCLAW_STATE_SCHEMA_SQL,
            { databaseLabel: pathname },
          );
          if (strictMigration.migratedTables.length > 0) {
            applied.push(
              `Migrated shared state tables to SQLite STRICT typing (${strictMigration.migratedTables.length})`,
            );
          }
        }
        markCurrentStateSchemaVersion(db);
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
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

function ensureSchema(db: DatabaseSync, pathname: string): void {
  const now = Date.now();
  const kysely = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(db);
  // Rebuilding referenced tables requires disabling FK enforcement before BEGIN.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runSqliteImmediateTransactionSync(
      db,
      () => {
        assertSupportedSchemaVersion(db, pathname);
        const previousVersion = readSqliteUserVersion(db);
        dropLegacyStateTables(db);
        ensureAdditiveStateColumns(db);
        sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        assertCanonicalStateSchemaShape(db, pathname);
        db.exec(OPENCLAW_STATE_SCHEMA_SQL);
        migrateLegacyCronRunLogsToTaskRuns(db);
        if (previousVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
          migrateSqliteSchemaToStrictInTransaction(db, OPENCLAW_STATE_SCHEMA_SQL, {
            databaseLabel: pathname,
          });
        }
        repairCanonicalSqliteUniqueIndexes(db, pathname, OPENCLAW_STATE_CANONICAL_UNIQUE_INDEXES);
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
              conflict.column("meta_key").doUpdateSet({
                role: "global",
                schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
                agent_id: null,
                app_version: VERSION,
                updated_at: now,
              }),
            ),
        );
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

function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < OPENCLAW_STATE_SCHEMA_VERSION)
  ) {
    // Migration rewrites the schema; prove the whole file before that mutation.
    // Only a truly empty v0 file may skip; legacy v0 files need the same proof.
    stateDbLog.info("state database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    assertSqliteIntegrity(database, pathname);
    return;
  }
  if (tableExists(database, "schema_meta")) {
    assertSqliteTableIntegrity(database, pathname, "schema_meta");
  }
}

/** Open or return a cached shared state database after schema and migration checks. */

export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  // Latched paths are quarantined: the recorder closed any live handle, and
  // every open fails fast here until doctor repairs the file and clears it.
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    return cached;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }
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
    // A broken quarantine store must not brick every state open.
    // The process latch and daily verifier still cover known damage.
  }
  if (quarantineFailure) {
    throw quarantineFailure;
  }
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
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
      ensureSchema(db, pathname);
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
  const database = { db, path: pathname, walMaintenance };
  cachedDatabases.set(pathname, database);
  terminalOpenLatch.clear(pathname);
  return database;
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
  const database = openOpenClawStateDatabase(options);
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database), {
    busyTimeoutMs: transactionOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    databaseLabel: database.path,
    ...transactionOptions,
    operationLabel: transactionOptions.operationLabel ?? "state.write",
  });
  try {
    ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
  } catch {
    // The write already committed; permission hardening is best-effort here so
    // callers never retry an operation that is durable in SQLite.
  }
  return result;
}

/** Close all cached shared state database handles. */
export function closeOpenClawStateDatabase(): void {
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    if (database.db.isOpen) {
      database.db.close();
    }
  }
  cachedDatabases.clear();
}

/** Test whether any cached shared state database handle is still open. */
export function isOpenClawStateDatabaseOpen(): boolean {
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

/** Close shared state handles and clear terminal failure latches for test isolation. */
export function closeOpenClawStateDatabaseForTest(): void {
  closeOpenClawStateDatabase();
  terminalOpenLatch.clearAll();
}
