import type { DatabaseSync } from "node:sqlite";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
  type SqliteLockFailureReporting,
} from "../infra/sqlite-busy-timeout.js";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
} from "../infra/sqlite-integrity.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";

const stateDbLog = createSubsystemLogger("state/db");

function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  const contentVersion = readStateSchemaContentVersion(database);
  const hasApplicationSchema = database // sqlite-allow-raw -- Cold-open schema presence probe before Kysely exposure.
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  const migrationPending =
    (contentVersion === 0 && hasApplicationSchema) ||
    (contentVersion > 0 && contentVersion < OPENCLAW_STATE_SCHEMA_VERSION);
  if (migrationPending) {
    stateDbLog.info("state database schema migration pending; verifying integrity first", {
      fromVersion: contentVersion,
      path: pathname,
      toVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  }
  if (contentVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
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
  const db = openNodeSqliteDatabase(params.pathname);
  enableNodeSqliteKyselyStatementCache(db);
  setSqliteBusyTimeout(db, busyTimeoutMs);
  const walMaintenance = runWithSqliteBusyTimeout(
    db,
    busyTimeoutMs,
    () => {
      let maintenance: SqliteWalMaintenance | undefined;
      try {
        assertSupportedStateSchemaVersion(db, params.pathname);
        assertStateDatabaseIntegrityBeforeMutation(db, params.pathname);
        configureSqlitePreSchemaPragmas(db, { busyTimeoutMs });
        maintenance = configureSqliteConnectionPragmas(db, {
          busyTimeoutMs,
          databaseLabel: "openclaw-state",
          databasePath: params.pathname,
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        params.ensureSchema(db);
        return maintenance;
      } catch (error) {
        maintenance?.close();
        db.close();
        if (
          error instanceof Error &&
          (isSqliteSchemaVersionError(error) || isTerminalSqliteIntegrityError(error))
        ) {
          params.recordOpenFailure(params.pathname, error);
        }
        throw error;
      }
    },
    { lockFailureReporting },
  );
  ensureOpenClawStatePermissions(params.pathname, params.env);
  return { db, path: params.pathname, walMaintenance };
}
