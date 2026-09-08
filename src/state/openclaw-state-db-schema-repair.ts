import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import {
  canRepairLegacyAuditEventsSchema,
  hasCanonicalAuditEventsSchema,
} from "./openclaw-state-db-audit-migration.js";
import {
  OPENCLAW_STATE_STRICT_SCHEMA_VERSION,
  type OpenClawStateDatabaseOptions,
  type OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
import { resolveDatabasePath } from "./openclaw-state-db-maintenance.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "./openclaw-state-db-readonly.js";
import {
  tableExists,
  tableHasColumn,
  tablePrimaryKeyColumns,
} from "./openclaw-state-db-schema-helpers.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import { FOLDED_SINGLETON_STATE_TABLES_V12 } from "./openclaw-state-db-schema-v12-foldin.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import * as sessionWatchMigration from "./openclaw-state-db-session-watch-migration.js";
import {
  hasRecognizedRetiredCommitmentsSchema,
  RETIRED_COMMITMENTS_SCHEMA_VERSION,
  RETIRED_DEAD_STATE_TABLES_V10,
  RETIRED_SKILL_CURATOR_TABLES_V11,
} from "./openclaw-state-db-table-retirements.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawStateDirForDatabasePath,
} from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export function dropLegacyStateTables(db: DatabaseSync): void {
  // Unreleased transient history; drop, do not migrate.
  const transientHistoryTable = ["database", "verifications"].join("_");
  db.exec(`DROP TABLE IF EXISTS ${transientHistoryTable};`);
  // Retired node pairing tables never had a shipped writer.
  db.exec("DROP TABLE IF EXISTS node_pairing_pending; DROP TABLE IF EXISTS node_pairing_paired;");
}

export function migrateWorkerPlacementExecutionModeSchema(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 8 || !tableExists(db, "worker_session_placements")) {
    return false;
  }
  for (const definition of [
    "execution_mode TEXT",
    "terminal_reason TEXT",
    "terminal_at_ms INTEGER",
  ]) {
    const column = definition.split(" ", 1)[0]!;
    if (!tableHasColumn(db, "worker_session_placements", column)) {
      db.exec(`ALTER TABLE worker_session_placements ADD COLUMN ${definition};`);
    }
  }
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS worker_session_placements (",
  );
  const endMarker = "\n) STRICT;";
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error("Canonical worker placement schema block is missing");
  }
  const placementSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + endMarker.length);
  const canonical = openNodeSqliteDatabase(":memory:");
  let canonicalColumns: string[];
  try {
    canonical.exec(placementSchema);
    canonicalColumns = (
      canonical.prepare("PRAGMA table_xinfo(worker_session_placements)").all() as Array<{
        hidden: number;
        name: string;
      }>
    )
      .filter((column) => column.hidden === 0)
      .map((column) => column.name);
  } finally {
    canonical.close();
  }
  const currentColumns = (
    db.prepare("PRAGMA table_xinfo(worker_session_placements)").all() as Array<{
      hidden: number;
      name: string;
    }>
  )
    .filter((column) => column.hidden === 0)
    .map((column) => column.name);
  const expected = new Set(canonicalColumns);
  if (
    currentColumns.length !== canonicalColumns.length ||
    currentColumns.some((column) => !expected.has(column))
  ) {
    throw new Error("OpenClaw v7 worker placement columns are not canonical");
  }
  const unexpectedObjects = db
    .prepare(
      `SELECT type, name
         FROM sqlite_schema
        WHERE tbl_name = 'worker_session_placements'
          AND type IN ('index', 'trigger')
          AND sql IS NOT NULL
          AND name NOT IN (
            'idx_worker_session_placements_session_key',
            'idx_worker_session_placements_reconcile'
          )`,
    )
    .all();
  if (unexpectedObjects.length > 0) {
    throw new Error("OpenClaw v7 worker placement schema has unsupported attached objects");
  }
  const migrationTable = "worker_session_placements_migration_v8";
  if (tableExists(db, migrationTable)) {
    throw new Error(`OpenClaw worker placement migration table already exists: ${migrationTable}`);
  }
  const migrationSchema = placementSchema.replace(
    "CREATE TABLE IF NOT EXISTS worker_session_placements",
    `CREATE TABLE ${migrationTable}`,
  );
  const columns = canonicalColumns.map(quoteSqliteIdentifier).join(", ");
  db.exec(migrationSchema);
  db.exec(
    `INSERT INTO ${migrationTable} (${columns}) SELECT ${columns} FROM worker_session_placements;`,
  );
  db.exec("DROP TABLE worker_session_placements;");
  db.exec(`ALTER TABLE ${migrationTable} RENAME TO worker_session_placements;`);
  return true;
}

function isDefaultAgentDatabasePath(pathname: string, agentId: string): boolean {
  const agentDir = path.dirname(pathname);
  const agentIdDir = path.dirname(agentDir);
  return (
    path.basename(pathname) === "openclaw-agent.sqlite" &&
    path.basename(agentDir) === "agent" &&
    path.basename(agentIdDir) === agentId &&
    path.basename(path.dirname(agentIdDir)) === "agents"
  );
}

export type AgentDatabasePathMigrationSummary = {
  relativized: number;
  reanchored: string[];
  deleted: string[];
  preserved: number;
};

export function migrateAgentDatabaseRelativePaths(
  db: DatabaseSync,
  previousVersion: number,
  databasePath: string,
): AgentDatabasePathMigrationSummary {
  if (previousVersion >= 9 || !tableExists(db, "agent_databases")) {
    return { relativized: 0, reanchored: [], deleted: [], preserved: 0 };
  }
  const rows = db.prepare("SELECT agent_id, path FROM agent_databases").all();
  const updatePath = db.prepare(
    "UPDATE agent_databases SET path = ? WHERE agent_id = ? AND path = ?",
  );
  const deletePath = db.prepare("DELETE FROM agent_databases WHERE agent_id = ? AND path = ?");
  const hasPath = db.prepare(
    "SELECT 1 FROM agent_databases WHERE agent_id = ? AND path = ? LIMIT 1",
  );
  let relativized = 0;
  const reanchored: string[] = [];
  const deleted: string[] = [];
  for (const row of rows) {
    const agentId = row.agent_id;
    const registeredPath = row.path;
    if (typeof agentId !== "string" || typeof registeredPath !== "string") {
      throw new Error("OpenClaw v8 agent database registry paths are not canonical");
    }
    if (!path.isAbsolute(registeredPath)) {
      continue;
    }
    const storedPath = resolveOpenClawAgentDatabaseStoredPath(databasePath, registeredPath);
    if (!path.isAbsolute(storedPath)) {
      updatePath.run(storedPath, agentId, registeredPath);
      relativized += 1;
    }
  }
  const stateDir = resolveOpenClawStateDirForDatabasePath(databasePath);
  for (const row of rows) {
    const agentId = row.agent_id;
    const registeredPath = row.path;
    if (
      typeof agentId !== "string" ||
      typeof registeredPath !== "string" ||
      !path.isAbsolute(registeredPath) ||
      !path.isAbsolute(resolveOpenClawAgentDatabaseStoredPath(databasePath, registeredPath))
    ) {
      continue;
    }
    const absolutePath = path.resolve(registeredPath);
    if (isDefaultAgentDatabasePath(absolutePath, agentId)) {
      const counterpartAbsolute = path.join(
        stateDir,
        "agents",
        agentId,
        "agent",
        "openclaw-agent.sqlite",
      );
      const counterpartStored = resolveOpenClawAgentDatabaseStoredPath(
        databasePath,
        counterpartAbsolute,
      );
      if (hasPath.get(agentId, counterpartStored)) {
        // The same agent already owns its in-root canonical registration. Keeping a second
        // default-layout registration guarantees duplicate canonical session keys on every list.
        deletePath.run(agentId, registeredPath);
        deleted.push(registeredPath);
      } else if (existsSync(counterpartAbsolute)) {
        // Re-anchor a copied or moved state directory onto its copied database instead of
        // deleting the registration or leaving it dangling at the source root.
        updatePath.run(counterpartStored, agentId, registeredPath);
        reanchored.push(registeredPath);
      }
    }
  }
  return {
    relativized,
    reanchored,
    deleted,
    preserved: rows.length - relativized - reanchored.length - deleted.length,
  };
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
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): OpenClawStateDatabaseSchemaMigration[] {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return [];
  }
  if (behavior.artifactPreservingReadOnly) {
    return (
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(db, pathname),
        { ...options, path: pathname },
      ) ?? []
    );
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
  const userVersion = readStateSchemaContentVersion(db);
  if (
    userVersion < RETIRED_COMMITMENTS_SCHEMA_VERSION &&
    tableExists(db, "commitments") &&
    hasRecognizedRetiredCommitmentsSchema(db)
  ) {
    migrations.push({ kind: "commitments-retirement-v7", path: pathname });
  }
  if (userVersion === 7 && tableExists(db, "worker_session_placements")) {
    migrations.push({ kind: "worker-placement-execution-mode-v8", path: pathname });
  }
  if (userVersion === 8 && tableExists(db, "agent_databases")) {
    migrations.push({ kind: "agent-databases-relative-paths-v9", path: pathname });
  }
  if (
    userVersion < 10 &&
    RETIRED_DEAD_STATE_TABLES_V10.some((tableName) => tableExists(db, tableName))
  ) {
    migrations.push({ kind: "state-table-retirement-v10", path: pathname });
  }
  if (
    userVersion < 11 &&
    RETIRED_SKILL_CURATOR_TABLES_V11.some((tableName) => tableExists(db, tableName))
  ) {
    migrations.push({ kind: "state-table-retirement-v11", path: pathname });
  }
  if (
    userVersion < 12 &&
    FOLDED_SINGLETON_STATE_TABLES_V12.some((tableName) => tableExists(db, tableName))
  ) {
    migrations.push({ kind: "singleton-state-foldin-v12", path: pathname });
  }
  if (
    userVersion < 13 &&
    (tableHasColumn(db, "cron_jobs", "schedule_kind") ||
      tableHasColumn(db, "subagent_runs", "task") ||
      tableExists(db, "workspace_attestations") ||
      tableExists(db, "installed_plugin_index") ||
      tableExists(db, "auth_profile_stores"))
  ) {
    migrations.push({ kind: "state-consolidation-v13", path: pathname });
  }
  if (userVersion < 14 && tableExists(db, "cron_jobs")) {
    migrations.push({ kind: "creator-namespace-v14", path: pathname });
  }
  if (
    userVersion < 15 &&
    (tableHasColumn(db, "current_conversation_bindings", "target_agent_id") ||
      tableHasColumn(db, "current_conversation_bindings", "target_session_id"))
  ) {
    migrations.push({ kind: "conversation-binding-targets-v15", path: pathname });
  }
  if (
    userVersion < 16 &&
    (tableHasColumn(db, "skill_workshop_proposals", "workspace_dir") ||
      tableHasColumn(db, "skill_workshop_proposals", "claim_released_time") ||
      tableHasColumn(db, "skill_workshop_collection_reviews", "workspace_dir"))
  ) {
    migrations.push({ kind: "skill-workshop-directory-ownership-v16", path: pathname });
  }
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
