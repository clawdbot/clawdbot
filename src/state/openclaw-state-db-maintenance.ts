import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteSchemaContains,
  assertSqliteSchemaTablesPresent,
} from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const STATE_V6_ADDITIVE_TABLES = [
  ...LAZY_ADDITIVE_STATE_TABLES,
  "worker_session_tool_operations",
  "worker_turn_tool_authorities",
] as const;
const STATE_V5_ADDITIVE_TABLES = [
  "agent_database_leases",
  "agent_deletion_journal",
  "claw_cron_refs",
  "claw_installs",
  "claw_mcp_server_refs",
  "claw_package_refs",
  "claw_workspace_files",
  "config_machine_state",
  "cron_job_scratch",
  "meeting_transcript_sessions",
  "meeting_transcript_summaries",
  "meeting_transcript_utterances",
  "outbound_media_provenance",
  "worker_environment_credentials",
  "worker_transcript_commit_heads",
  "worker_transcript_commits",
  ...STATE_V6_ADDITIVE_TABLES,
] as const;
const STATE_MIGRATION_ALLOWED_MISSING_TABLES = {
  5: STATE_V5_ADDITIVE_TABLES,
  6: STATE_V6_ADDITIVE_TABLES,
  7: STATE_V6_ADDITIVE_TABLES,
  8: STATE_V6_ADDITIVE_TABLES,
  9: STATE_V6_ADDITIVE_TABLES,
} as const satisfies Record<number, readonly string[]>;
type OpenClawStateMigrationVersion = keyof typeof STATE_MIGRATION_ALLOWED_MISSING_TABLES;

/** Open shared SQLite database handle plus WAL maintenance lifecycle. */

export function createOpenClawDatabaseVerificationError(
  kind: "agent" | "state",
  pathname: string,
  storedError: string | null,
): Error {
  // Doctor's clearing hooks run after a full integrity assertion, so a still-
  // corrupt file cannot be cleared directly: the file must be healthy first.
  const error = new Error(
    `OpenClaw ${kind} database ${pathname} is quarantined after integrity verification failed: ${storedError ?? "unknown integrity error"}. Restore the database from a backup or repair it, then run openclaw doctor --fix to clear the quarantine. See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
  );
  error.name = "SqliteIntegrityError";
  return error;
}

export function assertSupportedSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      pathname,
      userVersion,
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  }
}

/** Require canonical shared-state ownership without requiring the latest schema. */
export function assertOpenClawStateDatabaseOwner(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  const hasMetadataTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta' LIMIT 1")
    .get();
  const metadata = hasMetadataTable
    ? (database.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary' LIMIT 1").get() as
        | { role?: unknown }
        | undefined)
    : undefined;
  if (metadata?.role !== "global") {
    const role = typeof metadata?.role === "string" ? metadata.role : "missing";
    throw new Error(
      `OpenClaw state database ${options.pathname} has schema role ${role}; expected global.`,
    );
  }
}

/** Require the canonical shared-state owner and schema before offline file maintenance. */
export function assertOpenClawStateDatabaseForMaintenance(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      options.pathname,
      userVersion,
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  }
  if (userVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw state database ${options.pathname} uses schema version ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }

  assertOpenClawStateDatabaseOwner(database, options);
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== OPENCLAW_STATE_SCHEMA_VERSION) {
    const schemaVersion =
      typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new Error(
      `OpenClaw state database ${options.pathname} metadata schema version ${schemaVersion} does not match ${OPENCLAW_STATE_SCHEMA_VERSION}; run openclaw doctor --fix before compacting it.`,
    );
  }
  assertSqliteSchemaContains(
    database,
    options.pathname,
    OPENCLAW_STATE_SCHEMA_SQL,
    OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  );
}

function assertOpenClawStateDatabaseVersionForMigration(
  database: DatabaseSync,
  options: { pathname: string; version: OpenClawStateMigrationVersion },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion !== options.version) {
    throw new Error(
      `OpenClaw state database ${options.pathname} uses schema version ${userVersion}; expected ${options.version} before migrating it.`,
    );
  }
  assertOpenClawStateDatabaseOwner(database, options);
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== options.version) {
    const schemaVersion =
      typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new Error(
      `OpenClaw state database ${options.pathname} metadata schema version ${schemaVersion} does not match ${options.version}; repair the ownership metadata before migrating it.`,
    );
  }
  assertSqliteSchemaTablesPresent(database, options.pathname, OPENCLAW_STATE_SCHEMA_SQL, {
    allowedMissingTables: STATE_MIGRATION_ALLOWED_MISSING_TABLES[options.version],
  });
}

/** Require every stable v5 table before the v6 additive migration can run. */
export function assertOpenClawStateDatabaseV5ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 5 });
}

/** Require every stable v6 table before the v7 retirement migration can run. */
export function assertOpenClawStateDatabaseV6ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 6 });
}

/** Require every stable v7 table before the v8 placement migration can run. */
export function assertOpenClawStateDatabaseV7ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 7 });
}

/** Require every stable v8 table before the v9 registry migration can run. */
export function assertOpenClawStateDatabaseV8ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 8 });
}

/** Require every stable v9 table before the v10 retirement migration can run. */
export function assertOpenClawStateDatabaseV9ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 9 });
}

export function markCurrentStateSchemaVersion(
  db: DatabaseSync,
  options: { createMetadataIfMissing?: boolean } = {},
): void {
  // Pre-v2 databases can legitimately predate the audit table. Leave their
  // version untouched so normal open can create the complete v2 schema first.
  if (!tableExists(db, "audit_events")) {
    return;
  }
  db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
  if (
    tableExists(db, "schema_meta") &&
    ["meta_key", "schema_version", "updated_at"].every((column) =>
      tableHasColumn(db, "schema_meta", column),
    )
  ) {
    const now = Date.now();
    if (options.createMetadataIfMissing) {
      // Recognized pre-metadata schemas may acquire the global owner row during
      // doctor migration. Conflicting existing ownership is preserved so the
      // final maintenance assertion rejects and rolls back the repair.
      db.prepare(
        `INSERT INTO schema_meta (
           meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
         ) VALUES ('primary', 'global', ?, NULL, NULL, ?, ?)
         ON CONFLICT(meta_key) DO UPDATE SET
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      ).run(OPENCLAW_STATE_SCHEMA_VERSION, now, now);
      return;
    }
    db.prepare(
      "UPDATE schema_meta SET schema_version = ?, updated_at = ? WHERE meta_key = 'primary'",
    ).run(OPENCLAW_STATE_SCHEMA_VERSION, now);
  }
}

export function resolveDatabasePath(options: OpenClawStateDatabaseOptions = {}): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}
