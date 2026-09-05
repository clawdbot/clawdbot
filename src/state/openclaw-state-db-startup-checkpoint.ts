import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { resolveDatabasePath } from "./openclaw-state-db-maintenance.js";
import { ensureOpenClawStatePermissions } from "./openclaw-state-db-permissions.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import {
  assertOpenClawStateWriteAllowed,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";

// Native Swift stores may create only these canonical objects before Node owns schema bootstrap.
const NATIVE_STARTUP_BOOTSTRAP_OBJECTS = new Set([
  "table:device_auth_tokens",
  "index:idx_device_auth_tokens_updated",
  "table:device_identities",
  "index:idx_device_identities_device",
  "table:exec_approvals_config",
  "table:macos_port_guardian_records",
  "index:idx_macos_port_guardian_records_port",
  "table:schema_meta",
  "table:state_leases",
  "index:idx_state_leases_expiry",
  "index:idx_state_leases_owner",
]);

export function isUninitializedNativeStartupDatabase(db: DatabaseSync): boolean {
  if (readSqliteUserVersion(db) !== 0) {
    return false;
  }
  const objects = db // sqlite-allow-raw -- Pre-bootstrap schema ownership is checked before Kysely exposure.
    .prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    .all();
  if (
    objects.some(
      ({ type, name }) =>
        typeof type !== "string" ||
        typeof name !== "string" ||
        !NATIVE_STARTUP_BOOTSTRAP_OBJECTS.has(`${type}:${name}`),
    )
  ) {
    return false;
  }
  const tableNames = new Set(
    objects.filter(({ type }) => type === "table").map(({ name }) => name),
  );
  if (
    tableNames.has("schema_meta") &&
    db // sqlite-allow-raw -- An existing metadata row means this is not an unowned fresh bootstrap.
      .prepare("SELECT 1 FROM schema_meta LIMIT 1")
      .get()
  ) {
    return false;
  }
  return !(
    tableNames.has("state_leases") &&
    db // sqlite-allow-raw -- Never initialize across another startup's existing migration lease.
      .prepare("SELECT 1 FROM state_leases LIMIT 1")
      .get()
  );
}

function ensureStartupMigrationCheckpointSchema(
  db: DatabaseSync,
  pathname: string,
  env: NodeJS.ProcessEnv,
): void {
  runSqliteImmediateTransactionSync(
    db,
    () => {
      assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
      assertSupportedStateSchemaVersion(db, pathname);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT,
          app_version TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state_leases (
          scope TEXT NOT NULL,
          lease_key TEXT NOT NULL,
          owner TEXT NOT NULL,
          expires_at INTEGER,
          heartbeat_at INTEGER,
          payload_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, lease_key)
        );
        CREATE INDEX IF NOT EXISTS idx_state_leases_expiry
          ON state_leases(expires_at, scope, lease_key)
          WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_state_leases_owner
          ON state_leases(owner, updated_at DESC);
      `);
      ensureColumn(db, "schema_meta", "app_version TEXT");
    },
    {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: pathname,
      operationLabel: "state.schema.ensure-startup-checkpoint",
    },
  );
}

export function withOpenClawStateStartupCheckpointConnection<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions,
  initializeCanonicalSchema: (db: DatabaseSync, pathname: string, env: NodeJS.ProcessEnv) => void,
): T {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  return runWithOpenClawStateWriteAccess(
    { databasePath: pathname, env },
    "startup migration checkpoint database operation",
    () => {
      ensureOpenClawStatePermissions(pathname, env);
      const db = openNodeSqliteDatabase(pathname);
      try {
        configureSqlitePreSchemaPragmas(db, {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        });
        assertSqliteIntegrity(db, pathname);
        if (isUninitializedNativeStartupDatabase(db)) {
          initializeCanonicalSchema(db, pathname, env);
        }
        ensureStartupMigrationCheckpointSchema(db, pathname, env);
        return callback(db);
      } finally {
        db.close();
        ensureOpenClawStatePermissions(pathname, env);
      }
    },
  );
}

/** Admit only recognized native bootstrap; versioned state stays on the read-only path. */
export function initializeNativeOpenClawStateConnection(
  options: OpenClawStateDatabaseOptions,
  initializeCanonicalSchema: (db: DatabaseSync, pathname: string, env: NodeJS.ProcessEnv) => void,
): void {
  if (
    !withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => isUninitializedNativeStartupDatabase(db),
      options,
    )
  ) {
    return;
  }
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  runWithOpenClawStateWriteAccess({ databasePath: pathname, env }, "native state bootstrap", () => {
    const db = openNodeSqliteDatabase(pathname);
    try {
      if (!isUninitializedNativeStartupDatabase(db)) {
        return;
      }
      assertSqliteIntegrity(db, pathname);
      initializeCanonicalSchema(db, pathname, env);
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
    ensureOpenClawStatePermissions(pathname, env);
  });
}
