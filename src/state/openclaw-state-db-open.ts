import type { DatabaseSync } from "node:sqlite";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import {
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "../infra/sqlite-coordinator.js";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { isSqliteSchemaVersionError, readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";

const stateDbLog = createSubsystemLogger("state/db");

function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database // sqlite-allow-raw -- Cold-open schema presence probe before Kysely exposure.
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

export function openUnpublishedStateDatabase(params: {
  pathname: string;
  env: NodeJS.ProcessEnv;
  busyTimeoutMs: number;
  lockFailureReporting: SqliteLockFailureReporting;
  ensureSchema: (database: DatabaseSync) => void;
  recordOpenFailure: (pathname: string, error: Error) => void;
}): OpenClawStateDatabase {
  const { busyTimeoutMs, lockFailureReporting } = params;
  ensureOpenClawStatePermissions(params.pathname, params.env);
  const db = openTrackedStateDatabase(params.pathname);
  let maintenance: SqliteWalMaintenance | undefined;
  try {
    enableNodeSqliteKyselyStatementCache(db);
    setSqliteBusyTimeout(db, busyTimeoutMs);
    runWithSqliteBusyTimeout(
      db,
      busyTimeoutMs,
      () => {
        assertSupportedStateSchemaVersion(db, params.pathname);
        assertStateDatabaseIntegrityBeforeMutation(db, params.pathname);
        configureSqlitePreSchemaPragmas(db, { busyTimeoutMs });
        maintenance = configureSqliteConnectionPragmas(db, {
          busyTimeoutMs,
          databaseLabel: "openclaw-state",
          databasePath: params.pathname,
          runMaintenance: (operation) =>
            runWithSqliteCoordinator(
              acquireStateDatabaseCoordinator({ databasePath: params.pathname, busyTimeoutMs: 0 }),
              "shared-state WAL maintenance",
              operation,
            ),
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        params.ensureSchema(db);
      },
      { lockFailureReporting },
    );
    ensureOpenClawStatePermissions(params.pathname, params.env);
    if (!maintenance) {
      throw new Error("State database opened without its maintenance owner");
    }
    return { db, path: params.pathname, walMaintenance: maintenance };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      maintenance?.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    try {
      closeTrackedStateDatabase(db);
    } catch (closeError) {
      errors.push(closeError);
    }
    if (
      error instanceof Error &&
      (isSqliteSchemaVersionError(error) || isTerminalSqliteIntegrityError(error))
    ) {
      params.recordOpenFailure(params.pathname, error);
    }
    if (errors.length > 1) {
      throw createSqliteLifecycleAggregateError(
        errors,
        `State database initialization and cleanup failed for ${params.pathname}`,
        error,
      );
    }
    throw error;
  }
}
