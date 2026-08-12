import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  assertSqliteSchemaContains,
  collectSqliteSchemaIssues,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  canRepairLegacyAuditEventsSchema,
  hasCanonicalAuditEventsSchema,
} from "./openclaw-state-db-audit-migration.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabaseOptions,
  type OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
import { resolveDatabasePath } from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import {
  tableExists,
  tableHasColumn,
  tablePrimaryKeyColumns,
} from "./openclaw-state-db-schema-helpers.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";

export function dropLegacyStateTables(db: DatabaseSync): void {
  // Unreleased transient history; drop, do not migrate.
  const transientHistoryTable = ["database", "verifications"].join("_");
  db.exec(`DROP TABLE IF EXISTS ${transientHistoryTable};`);
  // Retired node pairing tables never had a shipped writer.
  db.exec("DROP TABLE IF EXISTS node_pairing_pending; DROP TABLE IF EXISTS node_pairing_paired;");
}

const RETIRED_COMMITMENTS_SCHEMA_SQL = `
CREATE TABLE commitments (
  id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  account_id TEXT,
  recipient_id TEXT,
  thread_id TEXT,
  sender_id TEXT,
  kind TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_text TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  confidence REAL NOT NULL,
  due_earliest_ms INTEGER NOT NULL,
  due_latest_ms INTEGER NOT NULL,
  due_timezone TEXT NOT NULL,
  source_message_id TEXT,
  source_run_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_attempt_at_ms INTEGER,
  sent_at_ms INTEGER,
  dismissed_at_ms INTEGER,
  snoozed_until_ms INTEGER,
  expired_at_ms INTEGER,
  record_json TEXT NOT NULL
) STRICT;
CREATE INDEX idx_commitments_scope_due
  ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
CREATE INDEX idx_commitments_status_due
  ON commitments(status, due_earliest_ms, due_latest_ms);
CREATE INDEX idx_commitments_scope_dedupe
  ON commitments(agent_id, session_key, channel, dedupe_key, status);
CREATE INDEX idx_commitments_agent_due
  ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
CREATE INDEX idx_commitments_agent_sent
  ON commitments(agent_id, status, sent_at_ms, session_key);
`;

const EARLY_RETIRED_COMMITMENTS_SCHEMA_SQL = `
CREATE TABLE commitments (
  id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  due_earliest_ms INTEGER NOT NULL,
  due_latest_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
`;

const RETIRED_COMMITMENTS_INDEX_NAMES = [
  "idx_commitments_agent_due",
  "idx_commitments_agent_sent",
  "idx_commitments_scope_dedupe",
  "idx_commitments_scope_due",
  "idx_commitments_status_due",
] as const;

const RETIRED_COMMITMENTS_SCHEMA_COMPATIBILITY: SqliteSchemaCompatibility = {
  // These defaults shipped as independent same-version additive repairs, so
  // supported databases may mix canonical and defaulted definitions. The
  // surrounding exact-object check still rejects every other schema change.
  allowedColumnDefinitions: {
    "commitments.attempts": ["attempts INTEGER NOT NULL DEFAULT 0"],
    "commitments.confidence": ["confidence REAL NOT NULL DEFAULT 0"],
    "commitments.created_at_ms": ["created_at_ms INTEGER NOT NULL DEFAULT 0"],
    "commitments.dedupe_key": ["dedupe_key TEXT NOT NULL DEFAULT ''"],
    "commitments.due_timezone": ["due_timezone TEXT NOT NULL DEFAULT 'UTC'"],
    "commitments.kind": ["kind TEXT NOT NULL DEFAULT 'followup'"],
    "commitments.reason": ["reason TEXT NOT NULL DEFAULT ''"],
    "commitments.sensitivity": ["sensitivity TEXT NOT NULL DEFAULT 'normal'"],
    "commitments.source": ["source TEXT NOT NULL DEFAULT 'unknown'"],
    "commitments.suggested_text": ["suggested_text TEXT NOT NULL DEFAULT ''"],
  },
};

function hasExactRetiredCommitmentsSchema(
  db: DatabaseSync,
  schemaSql: string,
  expectedIndexNames: readonly string[],
  compatibility: SqliteSchemaCompatibility = {},
): boolean {
  if (collectSqliteSchemaIssues(db, schemaSql, compatibility).length > 0) {
    return false;
  }
  const attachedObjects = db
    .prepare(
      `SELECT type, name
           FROM sqlite_schema
          WHERE type IN ('index', 'trigger')
            AND tbl_name = 'commitments'
            AND sql IS NOT NULL
          ORDER BY type, name`,
    )
    .all() as Array<{ name: string; type: string }>;
  return (
    attachedObjects.length === expectedIndexNames.length &&
    attachedObjects.every(
      (object, index) => object.type === "index" && object.name === expectedIndexNames[index],
    )
  );
}

function assertRecognizedRetiredCommitmentsSchema(db: DatabaseSync): void {
  if (
    hasExactRetiredCommitmentsSchema(
      db,
      RETIRED_COMMITMENTS_SCHEMA_SQL,
      RETIRED_COMMITMENTS_INDEX_NAMES,
      RETIRED_COMMITMENTS_SCHEMA_COMPATIBILITY,
    ) ||
    hasExactRetiredCommitmentsSchema(db, EARLY_RETIRED_COMMITMENTS_SCHEMA_SQL, [])
  ) {
    return;
  }
  assertSqliteSchemaContains(
    db,
    "retired OpenClaw commitments schema",
    RETIRED_COMMITMENTS_SCHEMA_SQL,
  );
  throw new Error(
    "Retired OpenClaw commitments schema has unsupported additional indexes; refusing destructive migration.",
  );
}

export function migrateRetiredCommitmentsSchema(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 7) {
    return false;
  }
  if (!tableExists(db, "commitments")) {
    return false;
  }
  // The commitments runtime was removed before v7; retained rows are inert
  // migration debt and have no remaining product owner or export contract.
  assertRecognizedRetiredCommitmentsSchema(db);
  // DROP TABLE removes only the validated table's indexes and sqlite_stat rows.
  db.exec("DROP TABLE commitments;");
  return true;
}

function hasCanonicalAgentDatabasesPrimaryKey(db: DatabaseSync): boolean {
  if (!tableExists(db, "agent_databases")) {
    return true;
  }
  const primaryKey = tablePrimaryKeyColumns(db, "agent_databases");
  return primaryKey.length === 2 && primaryKey[0] === "agent_id" && primaryKey[1] === "path";
}

function canRepairAgentDatabasesPrimaryKey(db: DatabaseSync): boolean {
  if (!tableExists(db, "agent_databases")) {
    return false;
  }
  const requiredColumns = ["agent_id", "path", "schema_version", "last_seen_at", "size_bytes"];
  return requiredColumns.every((column) => tableHasColumn(db, "agent_databases", column));
}

export function repairAgentDatabasesCompositePrimaryKey(db: DatabaseSync): boolean {
  if (hasCanonicalAgentDatabasesPrimaryKey(db) || !canRepairAgentDatabasesPrimaryKey(db)) {
    return false;
  }
  // Released DBs may have PRIMARY KEY(agent_id); current registration upserts by
  // (agent_id,path) so explicit relocated agent DBs do not overwrite each other.
  db.exec(`
    DROP TABLE IF EXISTS agent_databases_migration_new;
    CREATE TABLE agent_databases_migration_new (
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      size_bytes INTEGER,
      PRIMARY KEY (agent_id, path)
    );
    INSERT OR REPLACE INTO agent_databases_migration_new (
      agent_id,
      path,
      schema_version,
      last_seen_at,
      size_bytes
    )
    SELECT
      agent_id,
      path,
      schema_version,
      last_seen_at,
      size_bytes
    FROM agent_databases
    WHERE agent_id IS NOT NULL AND path IS NOT NULL;
    DROP TABLE agent_databases;
    ALTER TABLE agent_databases_migration_new RENAME TO agent_databases;
  `);
  return true;
}

export function repairLegacyGatewayRestartHandoffsForStrictMigration(db: DatabaseSync): void {
  if (!tableExists(db, "gateway_restart_handoff")) {
    return;
  }
  // Schema v2 accepted fractional performance-clock values in INTEGER-affinity columns.
  // Expired handoffs are transient; retain live rows by canonicalizing only those REAL cells.
  db.prepare("DELETE FROM gateway_restart_handoff WHERE expires_at <= ?").run(Date.now());
  db.exec(`
    UPDATE gateway_restart_handoff
    SET
      restart_trace_started_at = CASE
        WHEN typeof(restart_trace_started_at) = 'real'
          THEN CAST(restart_trace_started_at AS INTEGER)
        ELSE restart_trace_started_at
      END,
      restart_trace_last_at = CASE
        WHEN typeof(restart_trace_last_at) = 'real'
          THEN CAST(restart_trace_last_at AS INTEGER)
        ELSE restart_trace_last_at
      END
    WHERE typeof(restart_trace_started_at) = 'real'
       OR typeof(restart_trace_last_at) = 'real';
  `);
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

export function assertCanonicalStateSchemaShape(db: DatabaseSync, pathname: string): void {
  operatorApprovalMigration.assertCanonicalOperatorApprovalKinds(db, pathname);
  if (!hasCanonicalAgentDatabasesPrimaryKey(db)) {
    if (canRepairAgentDatabasesPrimaryKey(db)) {
      throw new OpenClawStateDatabaseSchemaMigrationRequiredError(
        "agent-databases-composite-primary-key",
        pathname,
      );
    }
    throw new Error(
      `OpenClaw state database ${pathname} has a noncanonical agent database registry schema that cannot be repaired automatically; restore the canonical agent_databases shape before retrying.`,
    );
  }
  if (!hasCanonicalAuditEventsSchema(db)) {
    if (canRepairLegacyAuditEventsSchema(db)) {
      throw new OpenClawStateDatabaseSchemaMigrationRequiredError("audit-events-v2", pathname);
    }
    throw new Error(
      `OpenClaw state database ${pathname} has a noncanonical audit event schema that cannot be repaired automatically; restore the canonical audit_events shape before retrying.`,
    );
  }
}
export function detectOpenClawStateDatabaseSchemaMigrations(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabaseSchemaMigration[] {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return [];
  }
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(db, pathname);
  } finally {
    db.close();
  }
}

/**
 * Detect migrations against a caller-owned handle.
 *
 * Registry discovery runs this per lookup while already holding a state
 * connection; opening a second one there made reads scale with row count.
 */
export function detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(
  db: DatabaseSync,
  pathname: string,
): OpenClawStateDatabaseSchemaMigration[] {
  const migrations: OpenClawStateDatabaseSchemaMigration[] = [];
  const userVersion = readSqliteUserVersion(db);
  if (!hasCanonicalAgentDatabasesPrimaryKey(db)) {
    migrations.push({ kind: "agent-databases-composite-primary-key", path: pathname });
  }
  if (!hasCanonicalAuditEventsSchema(db)) {
    migrations.push({ kind: "audit-events-v2", path: pathname });
  }
  if (tableExists(db, "audit_events") && userVersion < OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
    migrations.push({ kind: "strict-tables-v3", path: pathname });
  }
  if (sessionWatchMigration.needsSessionWatchCursorProvenanceMigration(db, userVersion)) {
    migrations.push({ kind: "session-watch-cursor-provenance-v4", path: pathname });
  }
  migrations.push(...operatorApprovalMigration.detectOperatorApprovalSchemaMigration(db, pathname));
  return migrations;
}
