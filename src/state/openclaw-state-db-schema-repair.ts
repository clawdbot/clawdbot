import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  assertSqliteSchemaContains,
  collectSqliteNamedIndexContract,
  collectSqliteSchemaIssues,
  getCanonicalSqliteNamedIndexContracts,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
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
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawStateDirForDatabasePath,
} from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const LEGACY_FORCED_WORKER_ABANDONMENT_ERROR =
  "Cloud worker result abandoned by forced operator teardown";

export function dropLegacyStateTables(db: DatabaseSync): void {
  // Unreleased transient history; drop, do not migrate.
  const transientHistoryTable = ["database", "verifications"].join("_");
  db.exec(`DROP TABLE IF EXISTS ${transientHistoryTable};`);
  // Retired node pairing tables never had a shipped writer.
  db.exec("DROP TABLE IF EXISTS node_pairing_pending; DROP TABLE IF EXISTS node_pairing_paired;");
}

/** Add v8's semantic marker and promote supported pre-v8 error-prefix owners. */
export function migrateWorkerWorkspaceRetentionV8(db: DatabaseSync, previousVersion: number): void {
  if (previousVersion >= 8 || !tableExists(db, "worker_workspace_reconciliations")) {
    return;
  }
  if (!tableHasColumn(db, "worker_workspace_reconciliations", "forced_abandonment_retained")) {
    db.exec(
      "ALTER TABLE worker_workspace_reconciliations ADD COLUMN forced_abandonment_retained INTEGER;",
    );
  }
  if (previousVersion < 5 || previousVersion > 7) {
    return;
  }
  db.prepare(
    `UPDATE worker_workspace_reconciliations
     SET forced_abandonment_retained = 1
     WHERE forced_abandonment_retained IS NULL
       AND EXISTS (
         SELECT 1
         FROM worker_session_placements AS placement
         WHERE placement.session_id = worker_workspace_reconciliations.session_id
           AND placement.state = 'failed'
           AND placement.environment_id = worker_workspace_reconciliations.environment_id
           AND placement.active_owner_epoch = worker_workspace_reconciliations.owner_epoch
           AND placement.transition_generation > worker_workspace_reconciliations.placement_generation
           AND instr(placement.recovery_error, ?) = 1
       )`,
  ).run(LEGACY_FORCED_WORKER_ABANDONMENT_ERROR);
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

const SHIPPED_RETIRED_COMMITMENTS_SCHEMA_SQL = `
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
);
CREATE INDEX idx_commitments_scope_due
  ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
CREATE INDEX idx_commitments_status_due
  ON commitments(status, due_earliest_ms, due_latest_ms);
CREATE INDEX idx_commitments_scope_dedupe
  ON commitments(agent_id, session_key, channel, dedupe_key, status);
`;

const RETIRED_COMMITMENTS_INDEX_FINGERPRINTS = new Map(
  getCanonicalSqliteNamedIndexContracts(RETIRED_COMMITMENTS_SCHEMA_SQL).map(
    ({ fingerprint, name }) => [name, JSON.stringify(fingerprint)],
  ),
);
const RETIRED_COMMITMENTS_INDEX_NAMES = [...RETIRED_COMMITMENTS_INDEX_FINGERPRINTS.keys()];

const RETIRED_COMMITMENTS_ADDITIVE_COLUMNS = [
  "commitments.account_id",
  "commitments.recipient_id",
  "commitments.thread_id",
  "commitments.sender_id",
  "commitments.kind",
  "commitments.sensitivity",
  "commitments.source",
  "commitments.reason",
  "commitments.suggested_text",
  "commitments.dedupe_key",
  "commitments.confidence",
  "commitments.due_timezone",
  "commitments.source_message_id",
  "commitments.source_run_id",
  "commitments.created_at_ms",
  "commitments.attempts",
  "commitments.last_attempt_at_ms",
  "commitments.sent_at_ms",
  "commitments.dismissed_at_ms",
  "commitments.snoozed_until_ms",
  "commitments.expired_at_ms",
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
  allowedMissingColumns: RETIRED_COMMITMENTS_ADDITIVE_COLUMNS,
  allowedMissingIndexes: RETIRED_COMMITMENTS_INDEX_NAMES,
};

function hasSupportedRetiredCommitmentsSchema(
  db: DatabaseSync,
  schemaSql: string,
  compatibility: SqliteSchemaCompatibility,
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
  return attachedObjects.every(
    (object) =>
      object.type === "index" &&
      JSON.stringify(collectSqliteNamedIndexContract(db, object.name)) ===
        RETIRED_COMMITMENTS_INDEX_FINGERPRINTS.get(object.name),
  );
}

function assertRecognizedRetiredCommitmentsSchema(db: DatabaseSync): void {
  if (hasRecognizedRetiredCommitmentsSchema(db)) {
    return;
  }
  assertSqliteSchemaContains(
    db,
    "retired OpenClaw commitments schema",
    RETIRED_COMMITMENTS_SCHEMA_SQL,
    RETIRED_COMMITMENTS_SCHEMA_COMPATIBILITY,
  );
  throw new Error(
    "Retired OpenClaw commitments schema has unsupported additional indexes; refusing destructive migration.",
  );
}

function hasRecognizedRetiredCommitmentsSchema(db: DatabaseSync): boolean {
  return (
    hasSupportedRetiredCommitmentsSchema(
      db,
      RETIRED_COMMITMENTS_SCHEMA_SQL,
      RETIRED_COMMITMENTS_SCHEMA_COMPATIBILITY,
    ) ||
    hasSupportedRetiredCommitmentsSchema(
      db,
      SHIPPED_RETIRED_COMMITMENTS_SCHEMA_SQL,
      RETIRED_COMMITMENTS_SCHEMA_COMPATIBILITY,
    )
  );
}

function assertNoRetiredCommitmentsForeignKeys(db: DatabaseSync): void {
  const tables = db
    .prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'table' AND name <> 'commitments'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  for (const table of tables) {
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(table.name)})`)
      .all() as Array<{ table?: unknown }>;
    if (
      foreignKeys.some(
        (foreignKey) =>
          typeof foreignKey.table === "string" && foreignKey.table.toLowerCase() === "commitments",
      )
    ) {
      throw new Error(
        `Retired OpenClaw commitments schema is referenced by table ${table.name}; refusing destructive migration.`,
      );
    }
  }
}

function collectRetainedSchemaSql(db: DatabaseSync): Map<string, string> {
  return new Map(
    (
      db
        .prepare(
          `SELECT type, name, sql
             FROM sqlite_schema
            WHERE type IN ('trigger', 'view')
              AND tbl_name <> 'commitments'
              AND sql IS NOT NULL
            ORDER BY type, name`,
        )
        .all() as Array<{ name: string; sql: string; type: string }>
    ).map((object) => [`${object.type}:${object.name}`, object.sql]),
  );
}

function assertNoRetiredCommitmentsSchemaDependencies(db: DatabaseSync): void {
  const probeTable = "__openclaw_retired_commitments_probe";
  if (tableExists(db, probeTable)) {
    throw new Error(
      `OpenClaw state database already contains ${probeTable}; refusing destructive migration.`,
    );
  }
  const before = collectRetainedSchemaSql(db);
  const savepoint = "openclaw_probe_commitments_dependencies";
  db.exec(`SAVEPOINT ${savepoint};`);
  let changedObject: string | undefined;
  try {
    db.exec(`ALTER TABLE commitments RENAME TO ${quoteSqliteIdentifier(probeTable)};`);
    const after = collectRetainedSchemaSql(db);
    changedObject = [...before].find(([object, sql]) => after.get(object) !== sql)?.[0];
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
    // A broken retained object makes dependency resolution ambiguous. Refuse
    // rather than discard rows that object may still own indirectly.
    throw new Error(
      "Could not prove retained SQLite views and triggers independent of commitments; refusing destructive migration.",
      { cause: error },
    );
  }
  db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
  if (changedObject) {
    const [type, name] = changedObject.split(":", 2);
    throw new Error(
      `Retired OpenClaw commitments schema is referenced by ${type} ${name}; refusing destructive migration.`,
    );
  }
}

function assertVirtualTablesUsable(db: DatabaseSync, phase: "before" | "after"): void {
  const virtualTables = db
    .prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'table' AND lower(sql) LIKE 'create virtual table%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  for (const table of virtualTables) {
    try {
      db.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table.name)} LIMIT 1`).all();
    } catch (error) {
      throw new Error(
        `SQLite virtual table ${table.name} is unusable ${phase} commitments retirement.`,
        { cause: error },
      );
    }
  }
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
  assertNoRetiredCommitmentsForeignKeys(db);
  assertNoRetiredCommitmentsSchemaDependencies(db);
  assertVirtualTablesUsable(db, "before");
  const savepoint = "openclaw_retire_commitments_v7";
  db.exec(`SAVEPOINT ${savepoint};`);
  try {
    // DROP TABLE removes only the validated table's indexes and sqlite_stat rows.
    db.exec("DROP TABLE commitments;");
    assertVirtualTablesUsable(db, "after");
    db.exec(`RELEASE ${savepoint};`);
    return true;
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
    throw error;
  }
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
  if (
    userVersion < OPENCLAW_STATE_SCHEMA_VERSION &&
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
