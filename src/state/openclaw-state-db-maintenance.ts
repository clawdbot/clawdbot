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
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

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
  ...LAZY_ADDITIVE_STATE_TABLES,
] as const;

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

/** Require every stable v5 table before the v6 additive migration can run. */
export function assertOpenClawStateDatabaseV5ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion !== 5) {
    throw new Error(
      `OpenClaw state database ${options.pathname} uses schema version ${userVersion}; expected 5 before migrating it.`,
    );
  }
  assertOpenClawStateDatabaseOwner(database, options);
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== 5) {
    const schemaVersion =
      typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new Error(
      `OpenClaw state database ${options.pathname} metadata schema version ${schemaVersion} does not match 5; repair the ownership metadata before migrating it.`,
    );
  }
  assertSqliteSchemaTablesPresent(database, options.pathname, OPENCLAW_STATE_SCHEMA_SQL, {
    allowedMissingTables: STATE_V5_ADDITIVE_TABLES,
  });
}

export function resolveDatabasePath(options: OpenClawStateDatabaseOptions = {}): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}
