import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteSchemaContains,
  assertSqliteSchemaTablesPresent,
  type SqliteTableContractReader,
} from "../infra/sqlite-schema-contract.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import { migrateJsonCanonicalWideRowsV13 } from "./openclaw-state-db-schema-v13-widerow.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const STATE_V6_ADDITIVE_TABLES = [
  // v6-v12 databases may predate this former same-version lazy table.
  "gateway_origin_device_tokens",
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
  10: STATE_V6_ADDITIVE_TABLES,
  11: STATE_V6_ADDITIVE_TABLES,
  12: STATE_V6_ADDITIVE_TABLES,
  13: LAZY_ADDITIVE_STATE_TABLES,
  14: LAZY_ADDITIVE_STATE_TABLES,
  15: LAZY_ADDITIVE_STATE_TABLES,
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
  readTable?: SqliteTableContractReader,
): void {
  const userVersion = assertSupportedStateSchemaVersion(database, options.pathname);
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
    readTable,
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
function assertOpenClawStateDatabaseV5ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 5 });
}

/** Require every stable v6 table before the v7 retirement migration can run. */
function assertOpenClawStateDatabaseV6ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 6 });
}

/** Require every stable v7 table before the v8 placement migration can run. */
function assertOpenClawStateDatabaseV7ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 7 });
}

/** Require every stable v8 table before the v9 registry migration can run. */
function assertOpenClawStateDatabaseV8ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 8 });
}

/** Require every stable v9 table before the v10 retirement migration can run. */
function assertOpenClawStateDatabaseV9ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 9 });
}

/** Require every stable v10 table before the v11 curator retirement can run. */
function assertOpenClawStateDatabaseV10ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 10 });
}

/** Require every stable v11 table before singleton state folds into the v12 store. */
function assertOpenClawStateDatabaseV11ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 11 });
}

/** Require every stable v12 table before wide rows become JSON-canonical. */
function assertOpenClawStateDatabaseV12ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 12 });
}

/** Keep historical migration gates beside their version-specific ownership assertions. */
export const openClawStateMigrationAssertions = new Map([
  [5, assertOpenClawStateDatabaseV5ForMigration],
  [6, assertOpenClawStateDatabaseV6ForMigration],
  [7, assertOpenClawStateDatabaseV7ForMigration],
  [8, assertOpenClawStateDatabaseV8ForMigration],
  [9, assertOpenClawStateDatabaseV9ForMigration],
  [10, assertOpenClawStateDatabaseV10ForMigration],
  [11, assertOpenClawStateDatabaseV11ForMigration],
  [12, assertOpenClawStateDatabaseV12ForMigration],
  [
    13,
    (database: DatabaseSync, options: { pathname: string }) =>
      assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 13 }),
  ],
  [
    14,
    (database: DatabaseSync, options: { pathname: string }) =>
      assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 14 }),
  ],
  [
    15,
    (database: DatabaseSync, options: { pathname: string }) =>
      assertOpenClawStateDatabaseVersionForMigration(database, { ...options, version: 15 }),
  ],
]);

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

/** Historical jobs lost the creator's origin; preserve attribution without guessing authority. */
function migrateCronCreatorNamespaces(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 14 || !tableExists(db, "cron_jobs")) {
    return false;
  }
  db.exec(`
    UPDATE cron_jobs
       SET job_json = json_set(job_json, '$.createdActor.source', 'unknown')
     WHERE json_valid(job_json)
       AND json_extract(job_json, '$.createdActor.type') = 'human';
  `);
  return true;
}

/** Keep opaque plugin targets independent of agent identity without rewriting binding records. */
function migrateConversationBindingTargets(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 15) {
    return false;
  }
  const columns = ["target_agent_id", "target_session_id"].filter((column) =>
    tableHasColumn(db, "current_conversation_bindings", column),
  );
  if (columns.length === 0) {
    return false;
  }
  // The caller owns one transaction through index recreation and version publication.
  // Unknown schema dependencies must fail and roll back, never be dropped to force migration.
  db.exec("DROP INDEX IF EXISTS idx_current_conversation_bindings_target;");
  for (const column of columns) {
    db.exec(`ALTER TABLE current_conversation_bindings DROP COLUMN ${column};`);
  }
  return true;
}

// v15 collection cleanup released a dropped skill's claim so a path recreated by hand
// stayed user-owned. Doctor relocates every applied create into the Workshop directory,
// so released rows turn stale before the marker leaves with its column.
const RELEASED_WORKSHOP_CLAIM_REASON =
  "Skill Workshop released this skill in a collection review; the path stays user-owned.";

function staleReleasedWorkshopClaims(db: DatabaseSync): void {
  const released = db
    .prepare(
      "SELECT proposal_id, record_json FROM skill_workshop_proposals WHERE claim_released_time IS NOT NULL",
    )
    .all() as Array<{ proposal_id: string; record_json: string }>;
  if (released.length === 0) {
    return;
  }
  const staleAt = new Date().toISOString();
  const update = db.prepare(
    `UPDATE skill_workshop_proposals
       SET record_json = ?, status = 'stale', updated_at = ?, stale_at = ?, status_reason = ?
     WHERE proposal_id = ?`,
  );
  for (const row of released) {
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    const staleRecord = {
      ...record,
      status: "stale",
      updatedAt: staleAt,
      staleAt,
      statusReason: RELEASED_WORKSHOP_CLAIM_REASON,
    };
    update.run(
      JSON.stringify(staleRecord),
      staleAt,
      staleAt,
      RELEASED_WORKSHOP_CLAIM_REASON,
      row.proposal_id,
    );
  }
}

/** Remove row provenance after the Workshop directory becomes the ownership boundary. */
function migrateSkillWorkshopDirectoryOwnership(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 16) {
    return false;
  }
  const proposalColumns = ["workspace_dir", "claim_released_time"].filter((column) =>
    tableHasColumn(db, "skill_workshop_proposals", column),
  );
  const reviewHasWorkspace = tableHasColumn(
    db,
    "skill_workshop_collection_reviews",
    "workspace_dir",
  );
  if (proposalColumns.length === 0 && !reviewHasWorkspace) {
    return false;
  }
  if (proposalColumns.includes("claim_released_time")) {
    staleReleasedWorkshopClaims(db);
  }
  db.exec("DROP INDEX IF EXISTS idx_skill_workshop_collection_reviews_workspace_time;");
  for (const column of proposalColumns) {
    db.exec(`ALTER TABLE skill_workshop_proposals DROP COLUMN ${column};`);
  }
  if (reviewHasWorkspace) {
    db.exec("ALTER TABLE skill_workshop_collection_reviews DROP COLUMN workspace_dir;");
  }
  return true;
}

/** Version-gated column and row migrations, oldest first; each runs inside the caller's schema transaction. */
export const versionedStateMigrations: ReadonlyArray<{
  migrate: (db: DatabaseSync, previousVersion: number) => boolean;
  applied: string;
}> = [
  { migrate: migrateJsonCanonicalWideRowsV13, applied: "Consolidated shared state tables (v13)" },
  {
    migrate: migrateCronCreatorNamespaces,
    applied: "Qualified historical cron creator attribution as unknown (v14)",
  },
  {
    migrate: migrateConversationBindingTargets,
    applied: "Removed redundant conversation binding target projections (v15)",
  },
  {
    migrate: migrateSkillWorkshopDirectoryOwnership,
    applied: "Moved Skill Workshop ownership to its global directory (v16)",
  },
];
