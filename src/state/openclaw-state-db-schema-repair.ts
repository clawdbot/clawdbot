import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite, resolveNodeSqliteLocation } from "../infra/node-sqlite.js";
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
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";

export function dropLegacyStateTables(db: DatabaseSync): void {
  // Unreleased transient history; drop, do not migrate.
  const transientHistoryTable = ["database", "verifications"].join("_");
  db.exec(`DROP TABLE IF EXISTS ${transientHistoryTable};`);
  // Retired node pairing tables never had a shipped writer.
  db.exec("DROP TABLE IF EXISTS node_pairing_pending; DROP TABLE IF EXISTS node_pairing_paired;");
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

export function markCurrentStateSchemaVersion(db: DatabaseSync): void {
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
    db.prepare(
      "UPDATE schema_meta SET schema_version = ?, updated_at = ? WHERE meta_key = 'primary'",
    ).run(OPENCLAW_STATE_SCHEMA_VERSION, Date.now());
  }
}

export function assertCanonicalStateSchemaShape(db: DatabaseSync, pathname: string): void {
  operatorApprovalMigration.assertCanonicalOperatorApprovalKinds(db, pathname);
  if (!hasCanonicalAgentDatabasesPrimaryKey(db)) {
    throw new Error(
      `OpenClaw state database ${pathname} has a legacy agent database registry schema; run openclaw doctor --fix to migrate it.`,
    );
  }
  if (!hasCanonicalAuditEventsSchema(db)) {
    if (canRepairLegacyAuditEventsSchema(db)) {
      throw new Error(
        `OpenClaw state database ${pathname} has a legacy audit event schema; run openclaw doctor --fix to migrate it.`,
      );
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
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(resolveNodeSqliteLocation(pathname), { readOnly: true });
  try {
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
    migrations.push(
      ...operatorApprovalMigration.detectOperatorApprovalSchemaMigration(db, pathname),
    );
    return migrations;
  } finally {
    db.close();
  }
}
