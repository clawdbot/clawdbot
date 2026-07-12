// OpenClaw state database manages shared persisted state and migrations.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  repairCanonicalSqliteUniqueIndexes,
  type CanonicalSqliteUniqueIndex,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

/**
 * Shared OpenClaw SQLite state database lifecycle and metadata writers.
 *
 * This module owns schema creation, additive migrations for released state
 * tables, private file permissions, cached handles, and audit rows for
 * migrations/backups that operate on local state.
 */
export const OPENCLAW_STATE_SCHEMA_VERSION = 2;
/** Maximum time one synchronous SQLite call may wait for a lock. */
export const OPENCLAW_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const OPENCLAW_STATE_DIR_MODE = 0o700;
const OPENCLAW_STATE_FILE_MODE = 0o600;
const OPENCLAW_STATE_CANONICAL_UNIQUE_INDEXES = [
  {
    name: "idx_operator_approvals_resolution_ref",
    definition: "ON operator_approvals(resolution_ref)",
  },
  {
    name: "idx_worker_environments_provider_lease",
    definition: `
      ON worker_environments(provider_id, lease_id)
      WHERE lease_id IS NOT NULL
    `,
  },
] as const satisfies readonly CanonicalSqliteUniqueIndex[];

/** Open shared SQLite database handle plus WAL maintenance lifecycle. */
export type OpenClawStateDatabase = {
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

/** Options for resolving or overriding the shared state database path. */
export type OpenClawStateDatabaseOptions = {
  env?: NodeJS.ProcessEnv;
  path?: string;
};

export type OpenClawStateDatabaseSchemaMigration =
  | {
      kind: "agent-databases-composite-primary-key";
      path: string;
    }
  | {
      kind: "audit-events-v2";
      path: string;
    };

const cachedDatabases = new Map<string, OpenClawStateDatabase>();

type OpenClawStateMetadataDatabase = Pick<OpenClawStateKyselyDatabase, "schema_meta">;

function assertSupportedSchemaVersion(db: DatabaseSync, pathname: string): void {
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

const stateDbLog = createSubsystemLogger("state/db");

/** Targets already warned about, so chmod-less filesystems warn once per path. */
const chmodWarnedTargets = new Set<string>();

// Permission hardening is best-effort only on filesystems that cannot apply
// it: the database stays usable without the chmod, and crashing at open would
// take the gateway down on Azure Files/NFS/Docker volumes (#91919). Unexpected
// chmod failures still throw so credentials-adjacent hardening stays loud.
function bestEffortChmodSync(target: string, mode: number): void {
  const result = applyPrivateModeSync(target, mode);
  if (result.applied || chmodWarnedTargets.has(target)) {
    return;
  }
  chmodWarnedTargets.add(target);
  stateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
}

export function ensureOpenClawStatePermissions(pathname: string, env: NodeJS.ProcessEnv): void {
  const dir = path.dirname(pathname);
  const defaultDir = resolveOpenClawStateSqliteDir(env);
  const isDefaultStateDatabase =
    path.resolve(pathname) === path.resolve(resolveOpenClawStateSqlitePath(env));
  if (isDefaultStateDatabase && dir !== defaultDir) {
    throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);
  }
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_STATE_DIR_MODE });
  // Default state contains credentials-adjacent metadata; custom existing dirs keep caller modes.
  if (isDefaultStateDatabase || !dirExisted) {
    bestEffortChmodSync(dir, OPENCLAW_STATE_DIR_MODE);
  }
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    if (existsSync(candidate)) {
      bestEffortChmodSync(candidate, OPENCLAW_STATE_FILE_MODE);
    }
  }
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === columnName);
}

function tablePrimaryKeyColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
    pk?: unknown;
  }>;
  return rows
    .filter((row) => Number(row.pk ?? 0) > 0 && typeof row.name === "string")
    .toSorted((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))
    .map((row) => row.name as string);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

function ensureColumn(db: DatabaseSync, tableName: string, columnSql: string): boolean {
  const columnName = columnSql.trim().split(/\s+/, 1)[0];
  if (!columnName || !tableExists(db, tableName) || tableHasColumn(db, tableName, columnName)) {
    return false;
  }
  // State migrations are additive here; destructive or shape-changing repairs belong in doctor.
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
  return true;
}

function ensureOperatorApprovalResolutionRefs(db: DatabaseSync): void {
  if (!tableExists(db, "operator_approvals")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    ensureColumn(db, "operator_approvals", "resolution_ref TEXT");
    const rows = db
      .prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals")
      .all() as Array<{
      approval_id?: unknown;
      kind?: unknown;
      resolution_ref?: unknown;
    }>;
    const update = db.prepare(
      "UPDATE operator_approvals SET resolution_ref = ? WHERE approval_id = ?",
    );
    for (const row of rows) {
      if (typeof row.approval_id !== "string" || (row.kind !== "exec" && row.kind !== "plugin")) {
        throw new Error("operator approval row cannot be assigned a transport reference");
      }
      const resolutionRef = buildApprovalResolutionRef({
        approvalId: row.approval_id,
        approvalKind: row.kind,
      });
      if (row.resolution_ref !== resolutionRef) {
        update.run(resolutionRef, row.approval_id);
      }
    }
    const namespaceConflict = db
      .prepare(
        `SELECT canonical.approval_id
         FROM operator_approvals AS canonical
         JOIN operator_approvals AS referenced
           ON canonical.approval_id = referenced.resolution_ref
         WHERE canonical.approval_id <> referenced.approval_id
         LIMIT 1`,
      )
      .get();
    if (namespaceConflict) {
      throw new Error("operator approval ids conflict with durable transport references");
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_approvals_resolution_ref
        ON operator_approvals(resolution_ref);
    `);
  });
}

function repairLegacyTaskAgentAttribution(db: DatabaseSync): void {
  if (!tableExists(db, "task_runs") || !tableHasColumn(db, "task_runs", "requester_agent_id")) {
    return;
  }
  // Before requester_agent_id existed, scoped subagent/ACP rows stored the
  // requester in agent_id. Repair only rows with recoverable requester
  // provenance; global legacy rows must keep the existing fallback behavior.
  db.exec(`
    UPDATE task_runs
    SET
      requester_agent_id = CASE
        WHEN owner_key GLOB 'agent:*:*' THEN substr(
          owner_key,
          7,
          instr(substr(owner_key, 7), ':') - 1
        )
        WHEN requester_session_key GLOB 'agent:*:*' THEN substr(
          requester_session_key,
          7,
          instr(substr(requester_session_key, 7), ':') - 1
        )
        WHEN agent_id <> substr(
          child_session_key,
          7,
          instr(substr(child_session_key, 7), ':') - 1
        ) THEN agent_id
        ELSE NULL
      END,
      agent_id = substr(
        child_session_key,
        7,
        instr(substr(child_session_key, 7), ':') - 1
      )
    WHERE requester_agent_id IS NULL
      AND runtime IN ('subagent', 'acp')
      AND child_session_key GLOB 'agent:*:*'
      AND instr(substr(child_session_key, 7), ':') > 1
      AND (
        owner_key GLOB 'agent:*:*'
        OR requester_session_key GLOB 'agent:*:*'
        OR (
          agent_id IS NOT NULL
          AND agent_id <> substr(
            child_session_key,
            7,
            instr(substr(child_session_key, 7), ':') - 1
          )
        )
      );
  `);
}

function repairLegacyTaskDeliveryStatuses(db: DatabaseSync): void {
  if (!tableExists(db, "task_runs") || !tableHasColumn(db, "task_runs", "delivery_status")) {
    return;
  }
  // Successful sidecar imports archive their source, so database open must
  // also canonicalize rows already copied by released migrations.
  db.exec(`
    UPDATE task_runs
    SET delivery_status = 'not_applicable'
    WHERE delivery_status = 'not-requested';
  `);
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

function repairAgentDatabasesCompositePrimaryKey(db: DatabaseSync): boolean {
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

const AUDIT_EVENT_STATE_SCHEMA_VERSION = 2;

const AUDIT_EVENT_LEGACY_COLUMNS = [
  "sequence",
  "event_id",
  "source_id",
  "source_sequence",
  "occurred_at",
  "kind",
  "action",
  "status",
  "error_code",
  "actor_type",
  "actor_id",
  "agent_id",
  "session_key",
  "session_id",
  "run_id",
  "tool_call_id",
  "tool_name",
] as const;

const AUDIT_EVENT_V2_COLUMNS = [
  "sequence",
  "event_id",
  "source_id",
  "schema_version",
  "source_sequence",
  "occurred_at",
  "kind",
  "action",
  "status",
  "error_code",
  "actor_type",
  "actor_id",
  "agent_id",
  "session_key",
  "session_id",
  "run_id",
  "tool_call_id",
  "tool_name",
  "direction",
  "channel",
  "conversation_kind",
  "message_outcome",
  "reason_code",
  "delivery_kind",
  "failure_stage",
  "duration_ms",
  "result_count",
  "account_ref",
  "conversation_ref",
  "message_ref",
  "target_ref",
] as const;

type TableColumnInfo = {
  name?: unknown;
  notnull?: unknown;
  pk?: unknown;
};

function tableColumnInfo(db: DatabaseSync, tableName: string): TableColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as TableColumnInfo[];
}

function tableHasExactColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
): boolean {
  const names = tableColumnInfo(db, tableName).map((column) => column.name);
  return names.length === expected.length && names.every((name, index) => name === expected[index]);
}

function tableHasRequiredColumns(
  db: DatabaseSync,
  tableName: string,
  required: readonly string[],
): boolean {
  const columns = new Map(tableColumnInfo(db, tableName).map((column) => [column.name, column]));
  return required.every((name) => Number(columns.get(name)?.notnull ?? 0) === 1);
}

function tableSql(db: DatabaseSync, tableName: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" ? row.sql : undefined;
}

function tableHasUniqueColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{
    name?: unknown;
    unique?: unknown;
  }>;
  return indexes.some((index) => {
    if (Number(index.unique ?? 0) !== 1 || typeof index.name !== "string") {
      return false;
    }
    const escaped = index.name.replaceAll("'", "''");
    const columns = db.prepare(`PRAGMA index_info('${escaped}')`).all() as Array<{
      name?: unknown;
    }>;
    return columns.length === 1 && columns[0]?.name === columnName;
  });
}

function hasCanonicalAuditEventTable(
  db: DatabaseSync,
  expectedColumns: readonly string[],
  requiredColumns: readonly string[],
): boolean {
  const sql = tableSql(db, "audit_events")?.toLowerCase();
  return (
    tableHasExactColumns(db, "audit_events", expectedColumns) &&
    tablePrimaryKeyColumns(db, "audit_events").join(",") === "sequence" &&
    tableHasRequiredColumns(db, "audit_events", requiredColumns) &&
    typeof sql === "string" &&
    /\bsequence\s+integer\s+primary\s+key\s+autoincrement\b/.test(sql) &&
    tableHasUniqueColumn(db, "audit_events", "event_id") &&
    tableHasUniqueColumn(db, "audit_events", "source_id")
  );
}

function hasCanonicalAuditIdentityKeyTable(db: DatabaseSync): boolean {
  if (!tableExists(db, "audit_identity_keys")) {
    return false;
  }
  const sql = tableSql(db, "audit_identity_keys")?.toLowerCase();
  return (
    tableHasExactColumns(db, "audit_identity_keys", ["id", "key_id", "key", "created_at"]) &&
    tablePrimaryKeyColumns(db, "audit_identity_keys").join(",") === "id" &&
    tableHasRequiredColumns(db, "audit_identity_keys", ["id", "key_id", "key", "created_at"]) &&
    typeof sql === "string" &&
    /\bcheck\s*\(\s*id\s*=\s*1\s*\)/.test(sql)
  );
}

function hasCanonicalAuditEventsSchema(db: DatabaseSync): boolean {
  if (!tableExists(db, "audit_events")) {
    return (
      readSqliteUserVersion(db) < AUDIT_EVENT_STATE_SCHEMA_VERSION &&
      !tableExists(db, "audit_identity_keys")
    );
  }
  return (
    hasCanonicalAuditEventTable(db, AUDIT_EVENT_V2_COLUMNS, [
      "event_id",
      "source_id",
      "schema_version",
      "source_sequence",
      "occurred_at",
      "kind",
      "action",
      "status",
      "actor_type",
      "actor_id",
    ]) && hasCanonicalAuditIdentityKeyTable(db)
  );
}

function canRepairLegacyAuditEventsSchema(db: DatabaseSync): boolean {
  // Our own transactional repair cannot leave audit_events_migration_new
  // behind, so an existing one is foreign data; fail closed rather than let
  // repair silently drop it.
  if (
    !tableExists(db, "audit_events") ||
    tableExists(db, "audit_events_migration_new") ||
    tableHasColumn(db, "audit_events", "schema_version")
  ) {
    return false;
  }
  const identityTableIsSafe =
    !tableExists(db, "audit_identity_keys") || hasCanonicalAuditIdentityKeyTable(db);
  return (
    identityTableIsSafe &&
    hasCanonicalAuditEventTable(db, AUDIT_EVENT_LEGACY_COLUMNS, [
      "event_id",
      "source_id",
      "source_sequence",
      "occurred_at",
      "kind",
      "action",
      "status",
      "actor_type",
      "actor_id",
      "agent_id",
      "run_id",
    ])
  );
}

function readAuditEventSequenceHighWater(db: DatabaseSync): number | undefined {
  if (!tableExists(db, "sqlite_sequence")) {
    return undefined;
  }
  const row = db
    .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'")
    .get() as { seq?: unknown } | undefined;
  if (row === undefined) {
    return undefined;
  }
  if (typeof row.seq !== "string" || !/^\d+$/.test(row.seq)) {
    throw new Error("audit event sequence high-water mark is invalid");
  }
  const sequence = BigInt(row.seq);
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("audit event sequence high-water mark exceeds the supported integer range");
  }
  return Number(sequence);
}

function restoreAuditEventSequenceHighWater(db: DatabaseSync, sequence: number | undefined): void {
  if (sequence === undefined) {
    return;
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'audit_events'").run();
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('audit_events', ?)").run(sequence);
}

function repairAuditEventsSchema(db: DatabaseSync): boolean {
  if (hasCanonicalAuditEventsSchema(db) || !canRepairLegacyAuditEventsSchema(db)) {
    return false;
  }
  const sequenceHighWater = readAuditEventSequenceHighWater(db);
  // This is the only shipped legacy shape. The surrounding doctor transaction
  // rolls back the table swap and sequence restore together on any bad row.
  // canRepairLegacyAuditEventsSchema refuses foreign audit_events_migration_new
  // tables, so this CREATE never clobbers existing data.
  db.exec(`
    CREATE TABLE audit_events_migration_new (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      source_sequence INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      agent_id TEXT,
      session_key TEXT,
      session_id TEXT,
      run_id TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      direction TEXT,
      channel TEXT,
      conversation_kind TEXT,
      message_outcome TEXT,
      reason_code TEXT,
      delivery_kind TEXT,
      failure_stage TEXT,
      duration_ms INTEGER,
      result_count INTEGER,
      account_ref TEXT,
      conversation_ref TEXT,
      message_ref TEXT,
      target_ref TEXT
    );
    INSERT INTO audit_events_migration_new (
      sequence,
      event_id,
      source_id,
      schema_version,
      source_sequence,
      occurred_at,
      kind,
      action,
      status,
      error_code,
      actor_type,
      actor_id,
      agent_id,
      session_key,
      session_id,
      run_id,
      tool_call_id,
      tool_name
    )
    SELECT
      sequence,
      event_id,
      source_id,
      1,
      source_sequence,
      occurred_at,
      kind,
      action,
      status,
      error_code,
      actor_type,
      actor_id,
      agent_id,
      session_key,
      session_id,
      run_id,
      tool_call_id,
      tool_name
    FROM audit_events;
    DROP TABLE audit_events;
    ALTER TABLE audit_events_migration_new RENAME TO audit_events;
    CREATE INDEX idx_audit_events_time
      ON audit_events(occurred_at DESC, sequence DESC);
    CREATE INDEX idx_audit_events_agent_sequence
      ON audit_events(agent_id, sequence DESC);
    CREATE INDEX idx_audit_events_session_sequence
      ON audit_events(session_key, sequence DESC);
    CREATE INDEX idx_audit_events_run_sequence
      ON audit_events(run_id, sequence DESC);
    CREATE INDEX idx_audit_events_kind_sequence
      ON audit_events(kind, sequence DESC);
    CREATE INDEX idx_audit_events_status_sequence
      ON audit_events(status, sequence DESC);
    CREATE INDEX idx_audit_events_channel_sequence
      ON audit_events(channel, sequence DESC);
    CREATE INDEX idx_audit_events_direction_sequence
      ON audit_events(direction, sequence DESC);
    CREATE TABLE IF NOT EXISTS audit_identity_keys (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      key_id TEXT NOT NULL,
      key BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // AUTOINCREMENT is part of the stable cursor contract. Rebuilding an empty
  // or sparsely retained table must not reuse a sequence already handed out.
  restoreAuditEventSequenceHighWater(db, sequenceHighWater);
  return true;
}

function markCurrentStateSchemaVersion(db: DatabaseSync): void {
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

function assertCanonicalStateSchemaShape(db: DatabaseSync, pathname: string): void {
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
  const db = new sqlite.DatabaseSync(pathname, { readOnly: true });
  try {
    const migrations: OpenClawStateDatabaseSchemaMigration[] = [];
    if (!hasCanonicalAgentDatabasesPrimaryKey(db)) {
      migrations.push({ kind: "agent-databases-composite-primary-key", path: pathname });
    }
    if (!hasCanonicalAuditEventsSchema(db)) {
      migrations.push({ kind: "audit-events-v2", path: pathname });
    }
    return migrations;
  } finally {
    db.close();
  }
}

export function repairOpenClawStateDatabaseSchema(options: OpenClawStateDatabaseOptions = {}): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  try {
    assertStateDatabaseIntegrityBeforeMutation(db, pathname);
    assertSupportedSchemaVersion(db, pathname);
    const changes = runSqliteImmediateTransactionSync(
      db,
      () => {
        const applied: string[] = [];
        if (repairAgentDatabasesCompositePrimaryKey(db)) {
          applied.push(`Migrated shared state agent database registry primary key → agent_id,path`);
        }
        if (repairAuditEventsSchema(db)) {
          applied.push(
            `Migrated shared state audit event ledger → versioned message lifecycle schema`,
          );
        }
        assertCanonicalStateSchemaShape(db, pathname);
        markCurrentStateSchemaVersion(db);
        return applied;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.repair",
      },
    );
    return { changes, warnings: [] };
  } catch (err) {
    return {
      changes: [],
      warnings: [`Failed migrating shared state database schema at ${pathname}: ${String(err)}`],
    };
  } finally {
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

function ensureStartupMigrationCheckpointSchema(db: DatabaseSync, pathname: string): void {
  runSqliteImmediateTransactionSync(
    db,
    () => {
      assertSupportedSchemaVersion(db, pathname);
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

export function withOpenClawStateStartupMigrationCheckpointDatabase<T>(
  callback: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  try {
    assertStateDatabaseIntegrityBeforeMutation(db, pathname);
    ensureStartupMigrationCheckpointSchema(db, pathname);
    return callback(db);
  } finally {
    db.close();
    ensureOpenClawStatePermissions(pathname, env);
  }
}

// One-time seed for the ledger footprint aggregates (#100622): estimate rows
// written before the estimated_bytes columns existed, then roll them up per
// session. Zero is a safe "not seeded" sentinel because every real row costs
// at least its 32-byte overhead.
function backfillAcpReplayEstimatedBytes(db: DatabaseSync): void {
  if (
    !tableExists(db, "acp_replay_events") ||
    !tableHasColumn(db, "acp_replay_events", "estimated_bytes")
  ) {
    return;
  }
  const pendingEvent = db
    .prepare("SELECT 1 FROM acp_replay_events WHERE estimated_bytes = 0 LIMIT 1")
    .get();
  const pendingSession = db
    .prepare("SELECT 1 FROM acp_replay_sessions WHERE estimated_bytes = 0 LIMIT 1")
    .get();
  if (!pendingEvent && !pendingSession) {
    return;
  }
  db.exec(`
    UPDATE acp_replay_events
       SET estimated_bytes = length(session_id) + length(session_key) + length(update_json)
             + COALESCE(length(run_id), 0) + 32
     WHERE estimated_bytes = 0;
    UPDATE acp_replay_sessions
       SET estimated_bytes = length(session_id) + length(session_key) + length(cwd) + 32
             + COALESCE((SELECT SUM(e.estimated_bytes) FROM acp_replay_events e
                          WHERE e.session_id = acp_replay_sessions.session_id), 0)
     WHERE estimated_bytes = 0;
  `);
}

function backfillCronRunLogEntryJson(db: DatabaseSync): void {
  if (!tableExists(db, "cron_run_logs") || !tableHasColumn(db, "cron_run_logs", "entry_json")) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, seq, ts
         FROM cron_run_logs
        WHERE entry_json = '{}'`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    seq: number | bigint;
    ts: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_run_logs
        SET entry_json = ?
      WHERE store_key = ? AND job_id = ? AND seq = ?`,
  );
  for (const row of rows) {
    update.run(
      JSON.stringify({ ts: Number(row.ts), jobId: row.job_id, action: "finished" }),
      row.store_key,
      row.job_id,
      row.seq,
    );
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonField(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function cronSessionTargetField(record: Record<string, unknown>): string | null {
  const value = textField(record, "sessionTarget");
  if (!value) {
    return null;
  }
  return value === "main" ||
    value === "isolated" ||
    value === "current" ||
    value.startsWith("session:")
    ? value
    : null;
}

function cronWakeModeField(record: Record<string, unknown>): string | null {
  const value = textField(record, "wakeMode");
  return value === "now" || value === "next-heartbeat" ? value : null;
}

function booleanField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function failureDestinationField(
  record: Record<string, unknown> | null,
  key: "accountId" | "channel" | "mode" | "to",
): string | null {
  if (!record || !Object.hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : "";
}

function migrateLegacyCronDeliveryThreadIds(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, delivery_thread_id
         FROM cron_jobs
        WHERE delivery_thread_id_type IS NULL`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    delivery_thread_id: string | null;
  }>;
  const update = db.prepare(
    `UPDATE cron_jobs
        SET delivery_thread_id = ?, delivery_thread_id_type = ?
      WHERE store_key = ? AND job_id = ? AND delivery_thread_id_type IS NULL`,
  );
  for (const row of rows) {
    const job = parseJsonRecord(row.job_json);
    const delivery = job ? recordField(job, "delivery") : null;
    const typed = delivery?.threadId;
    if (row.delivery_thread_id === null) {
      // The first normalized cron migration could not project numeric thread IDs.
      // Recover only that known lost shape while this type column is first added.
      if (typeof typed === "number" && Number.isFinite(typed)) {
        update.run(String(typed), "number", row.store_key, row.job_id);
      }
      continue;
    }
    const type =
      typeof typed === "number" &&
      Number.isFinite(typed) &&
      String(typed) === row.delivery_thread_id
        ? "number"
        : "string";
    update.run(row.delivery_thread_id, type, row.store_key, row.job_id);
  }
}

function backfillCronJobsFromJobJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "cron_jobs") ||
    !tableHasColumn(db, "cron_jobs", "job_json") ||
    !tableHasColumn(db, "cron_jobs", "schedule_kind") ||
    !tableHasColumn(db, "cron_jobs", "payload_kind")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, updated_at
         FROM cron_jobs
        WHERE schedule_kind = 'manual'
           OR payload_kind = 'message'
           OR name = ''`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    updated_at: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_jobs
        SET name = ?,
            enabled = ?,
            delete_after_run = ?,
            created_at_ms = ?,
            agent_id = ?,
            session_key = ?,
            schedule_kind = ?,
            schedule_expr = ?,
            schedule_tz = ?,
            every_ms = ?,
            anchor_ms = ?,
            at = ?,
            stagger_ms = ?,
            session_target = ?,
            wake_mode = ?,
            payload_kind = ?,
            payload_message = ?,
            payload_model = ?,
            payload_fallbacks_json = ?,
            payload_thinking = ?,
            payload_timeout_seconds = ?,
            payload_allow_unsafe_external_content = ?,
            payload_external_content_source_json = ?,
            payload_light_context = ?,
            payload_tools_allow_json = ?,
            delivery_mode = ?,
            delivery_channel = ?,
            delivery_to = ?,
            delivery_thread_id = ?,
            delivery_account_id = ?,
            delivery_best_effort = ?,
            delivery_completion_mode = ?,
            delivery_completion_to = ?,
            failure_delivery_mode = ?,
            failure_delivery_channel = ?,
            failure_delivery_to = ?,
            failure_delivery_account_id = ?,
            failure_alert_disabled = ?,
            failure_alert_after = ?,
            failure_alert_channel = ?,
            failure_alert_to = ?,
            failure_alert_cooldown_ms = ?,
            failure_alert_include_skipped = ?,
            failure_alert_mode = ?,
            failure_alert_account_id = ?,
            runtime_updated_at_ms = ?
      WHERE store_key = ?
        AND job_id = ?`,
  );
  for (const row of rows) {
    const job = parseJsonRecord(row.job_json);
    if (!job) {
      continue;
    }
    // Legacy cron rows kept the contract in job_json; columns are a queryable projection of it.
    const schedule = recordField(job, "schedule");
    const payload = recordField(job, "payload");
    const scheduleKind = textField(schedule ?? {}, "kind");
    const payloadKind = textField(payload ?? {}, "kind");
    const isAt = scheduleKind === "at" && textField(schedule ?? {}, "at");
    const isEvery = scheduleKind === "every" && numberField(schedule ?? {}, "everyMs") != null;
    const isCron = scheduleKind === "cron" && textField(schedule ?? {}, "expr");
    const isSystemEvent = payloadKind === "systemEvent" && textField(payload ?? {}, "text");
    const isAgentTurn = payloadKind === "agentTurn" && textField(payload ?? {}, "message");
    if (
      !schedule ||
      !payload ||
      (!isAt && !isEvery && !isCron) ||
      (!isSystemEvent && !isAgentTurn)
    ) {
      continue;
    }
    const fallbackTime = Number(row.updated_at) || 0;
    const delivery = recordField(job, "delivery");
    const completionDestination = delivery ? recordField(delivery, "completionDestination") : null;
    const failureDestination = delivery ? recordField(delivery, "failureDestination") : null;
    const failureAlertValue = job.failureAlert;
    const failureAlert =
      failureAlertValue &&
      typeof failureAlertValue === "object" &&
      !Array.isArray(failureAlertValue)
        ? (failureAlertValue as Record<string, unknown>)
        : null;
    update.run(
      textField(job, "name") ?? row.job_id,
      job.enabled === false ? 0 : 1,
      booleanField(job, "deleteAfterRun"),
      numberField(job, "createdAtMs") ?? fallbackTime,
      textField(job, "agentId"),
      textField(job, "sessionKey"),
      scheduleKind,
      isCron ? textField(schedule, "expr") : null,
      isCron ? textField(schedule, "tz") : null,
      isEvery ? numberField(schedule, "everyMs") : null,
      isEvery ? numberField(schedule, "anchorMs") : null,
      isAt ? textField(schedule, "at") : null,
      isCron ? numberField(schedule, "staggerMs") : null,
      cronSessionTargetField(job) ?? (payloadKind === "agentTurn" ? "isolated" : "main"),
      cronWakeModeField(job) ?? "now",
      payloadKind,
      isSystemEvent ? textField(payload, "text") : textField(payload, "message"),
      isAgentTurn ? textField(payload, "model") : null,
      isAgentTurn ? jsonField(payload.fallbacks) : null,
      isAgentTurn ? textField(payload, "thinking") : null,
      isAgentTurn ? numberField(payload, "timeoutSeconds") : null,
      isAgentTurn && typeof payload.allowUnsafeExternalContent === "boolean"
        ? payload.allowUnsafeExternalContent
          ? 1
          : 0
        : null,
      isAgentTurn ? jsonField(payload.externalContentSource) : null,
      isAgentTurn && typeof payload.lightContext === "boolean"
        ? payload.lightContext
          ? 1
          : 0
        : null,
      isAgentTurn ? jsonField(payload.toolsAllow) : null,
      delivery ? textField(delivery, "mode") : null,
      delivery ? textField(delivery, "channel") : null,
      delivery ? textField(delivery, "to") : null,
      delivery ? textField(delivery, "threadId") : null,
      delivery ? textField(delivery, "accountId") : null,
      delivery && typeof delivery.bestEffort === "boolean" ? (delivery.bestEffort ? 1 : 0) : null,
      completionDestination ? textField(completionDestination, "mode") : null,
      completionDestination ? textField(completionDestination, "to") : null,
      failureDestinationField(failureDestination, "mode"),
      failureDestinationField(failureDestination, "channel"),
      failureDestinationField(failureDestination, "to"),
      failureDestinationField(failureDestination, "accountId"),
      failureAlertValue === false ? 1 : failureAlert ? 0 : null,
      failureAlert ? numberField(failureAlert, "after") : null,
      failureAlert ? textField(failureAlert, "channel") : null,
      failureAlert ? textField(failureAlert, "to") : null,
      failureAlert ? numberField(failureAlert, "cooldownMs") : null,
      failureAlert && typeof failureAlert.includeSkipped === "boolean"
        ? failureAlert.includeSkipped
          ? 1
          : 0
        : null,
      failureAlert ? textField(failureAlert, "mode") : null,
      failureAlert ? textField(failureAlert, "accountId") : null,
      numberField(job, "updatedAtMs") ?? fallbackTime,
      row.store_key,
      row.job_id,
    );
  }
}

function metadataStringField(record: Record<string, unknown>, key: string): string | null {
  return textField(record, key);
}

function backfillDeliveryQueueEntriesFromEntryJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "delivery_queue_entries") ||
    !tableHasColumn(db, "delivery_queue_entries", "entry_json") ||
    !tableHasColumn(db, "delivery_queue_entries", "retry_count")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT queue_name, id, entry_json
         FROM delivery_queue_entries
        WHERE retry_count = 0
           OR last_attempt_at IS NULL
           OR last_error IS NULL
           OR recovery_state IS NULL
           OR platform_send_started_at IS NULL
           OR entry_kind IS NULL
           OR session_key IS NULL
           OR channel IS NULL
           OR target IS NULL
           OR account_id IS NULL`,
    )
    .all() as Array<{ queue_name: string; id: string; entry_json: string }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = COALESCE(?, entry_kind),
            session_key = COALESCE(?, session_key),
            channel = COALESCE(?, channel),
            target = COALESCE(?, target),
            account_id = COALESCE(?, account_id),
            retry_count = ?,
            last_attempt_at = COALESCE(?, last_attempt_at),
            last_error = COALESCE(?, last_error),
            recovery_state = COALESCE(?, recovery_state),
            platform_send_started_at = COALESCE(?, platform_send_started_at)
      WHERE queue_name = ?
        AND id = ?`,
  );
  for (const row of rows) {
    const entry = parseJsonRecord(row.entry_json);
    if (!entry) {
      continue;
    }
    // Queue metadata is denormalized for recovery queries but entry_json remains source of truth.
    const session = recordField(entry, "session");
    const route = recordField(entry, "route");
    const deliveryContext = recordField(entry, "deliveryContext");
    update.run(
      metadataStringField(entry, "kind"),
      metadataStringField(entry, "sessionKey") ??
        (session ? metadataStringField(session, "key") : null),
      metadataStringField(entry, "channel") ??
        (route ? metadataStringField(route, "channel") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "channel") : null),
      metadataStringField(entry, "to") ??
        (route ? metadataStringField(route, "to") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "to") : null),
      metadataStringField(entry, "accountId") ??
        (route ? metadataStringField(route, "accountId") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "accountId") : null),
      numberField(entry, "retryCount") ?? 0,
      numberField(entry, "lastAttemptAt"),
      metadataStringField(entry, "lastError"),
      metadataStringField(entry, "recoveryState"),
      numberField(entry, "platformSendStartedAt"),
      row.queue_name,
      row.id,
    );
  }
}

// The caller owns the state.schema.ensure transaction so every probe, DDL
// change, and backfill observes one authoritative schema across processes.
function ensureAdditiveStateColumns(db: DatabaseSync): void {
  ensureColumn(db, "device_pairing_pending", "refreshed_at_ms INTEGER");
  ensureColumn(db, "device_pairing_paired", "approved_via TEXT");
  ensureColumn(db, "device_pairing_paired", "operator_label TEXT");
  ensureColumn(db, "device_pairing_paired", "node_surface_json TEXT");
  ensureColumn(db, "device_pairing_paired", "pending_node_surface_json TEXT");
  ensureColumn(db, "cron_run_logs", "status TEXT");
  ensureColumn(db, "cron_run_logs", "error TEXT");
  ensureColumn(db, "cron_run_logs", "summary TEXT");
  ensureColumn(db, "cron_run_logs", "diagnostics_summary TEXT");
  ensureColumn(db, "cron_run_logs", "delivery_status TEXT");
  ensureColumn(db, "cron_run_logs", "delivery_error TEXT");
  ensureColumn(db, "cron_run_logs", "delivered INTEGER");
  ensureColumn(db, "cron_run_logs", "session_id TEXT");
  ensureColumn(db, "cron_run_logs", "session_key TEXT");
  ensureColumn(db, "cron_run_logs", "run_id TEXT");
  ensureColumn(db, "cron_run_logs", "run_at_ms INTEGER");
  ensureColumn(db, "cron_run_logs", "duration_ms INTEGER");
  ensureColumn(db, "cron_run_logs", "next_run_at_ms INTEGER");
  ensureColumn(db, "cron_run_logs", "model TEXT");
  ensureColumn(db, "cron_run_logs", "provider TEXT");
  ensureColumn(db, "cron_run_logs", "total_tokens INTEGER");
  ensureColumn(db, "cron_run_logs", "entry_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "cron_run_logs", "created_at INTEGER NOT NULL DEFAULT 0");
  backfillCronRunLogEntryJson(db);
  ensureColumn(db, "acp_replay_events", "estimated_bytes INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "acp_replay_sessions", "estimated_bytes INTEGER NOT NULL DEFAULT 0");
  backfillAcpReplayEstimatedBytes(db);
  ensureColumn(db, "cron_jobs", "description TEXT");
  ensureColumn(db, "cron_jobs", "declaration_key TEXT");
  ensureColumn(db, "cron_jobs", "display_name TEXT");
  ensureColumn(db, "cron_jobs", "owner_agent_id TEXT");
  ensureColumn(db, "cron_jobs", "owner_session_key TEXT");
  ensureColumn(db, "cron_jobs", "name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "cron_jobs", "enabled INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "cron_jobs", "delete_after_run INTEGER");
  ensureColumn(db, "cron_jobs", "created_at_ms INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "cron_jobs", "agent_id TEXT");
  ensureColumn(db, "cron_jobs", "session_key TEXT");
  ensureColumn(db, "cron_jobs", "schedule_kind TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, "cron_jobs", "schedule_expr TEXT");
  ensureColumn(db, "cron_jobs", "schedule_tz TEXT");
  ensureColumn(db, "cron_jobs", "every_ms INTEGER");
  ensureColumn(db, "cron_jobs", "anchor_ms INTEGER");
  ensureColumn(db, "cron_jobs", "at TEXT");
  ensureColumn(db, "cron_jobs", "stagger_ms INTEGER");
  ensureColumn(db, "cron_jobs", "session_target TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, "cron_jobs", "wake_mode TEXT NOT NULL DEFAULT 'auto'");
  ensureColumn(db, "cron_jobs", "trigger_script TEXT");
  ensureColumn(db, "cron_jobs", "trigger_once INTEGER");
  ensureColumn(db, "cron_jobs", "payload_kind TEXT NOT NULL DEFAULT 'message'");
  ensureColumn(db, "cron_jobs", "payload_message TEXT");
  ensureColumn(db, "cron_jobs", "payload_model TEXT");
  ensureColumn(db, "cron_jobs", "payload_fallbacks_json TEXT");
  ensureColumn(db, "cron_jobs", "payload_thinking TEXT");
  ensureColumn(db, "cron_jobs", "payload_timeout_seconds INTEGER");
  ensureColumn(db, "cron_jobs", "payload_allow_unsafe_external_content INTEGER");
  ensureColumn(db, "cron_jobs", "payload_external_content_source_json TEXT");
  ensureColumn(db, "cron_jobs", "payload_light_context INTEGER");
  ensureColumn(db, "cron_jobs", "payload_tools_allow_json TEXT");
  ensureColumn(db, "cron_jobs", "payload_tools_allow_is_default INTEGER");
  ensureColumn(db, "cron_jobs", "delivery_mode TEXT");
  ensureColumn(db, "cron_jobs", "delivery_channel TEXT");
  ensureColumn(db, "cron_jobs", "delivery_to TEXT");
  ensureColumn(db, "cron_jobs", "delivery_thread_id TEXT");
  ensureColumn(db, "cron_jobs", "delivery_account_id TEXT");
  ensureColumn(db, "cron_jobs", "delivery_best_effort INTEGER");
  ensureColumn(db, "cron_jobs", "delivery_completion_mode TEXT");
  ensureColumn(db, "cron_jobs", "delivery_completion_to TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_mode TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_channel TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_to TEXT");
  ensureColumn(db, "cron_jobs", "failure_delivery_account_id TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_disabled INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_after INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_channel TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_to TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_cooldown_ms INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_include_skipped INTEGER");
  ensureColumn(db, "cron_jobs", "failure_alert_mode TEXT");
  ensureColumn(db, "cron_jobs", "failure_alert_account_id TEXT");
  ensureColumn(db, "cron_jobs", "next_run_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "running_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "last_run_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "last_run_status TEXT");
  ensureColumn(db, "cron_jobs", "last_error TEXT");
  ensureColumn(db, "cron_jobs", "last_duration_ms INTEGER");
  ensureColumn(db, "cron_jobs", "consecutive_errors INTEGER");
  ensureColumn(db, "cron_jobs", "consecutive_skipped INTEGER");
  ensureColumn(db, "cron_jobs", "schedule_error_count INTEGER");
  ensureColumn(db, "cron_jobs", "last_delivery_status TEXT");
  ensureColumn(db, "cron_jobs", "last_delivery_error TEXT");
  ensureColumn(db, "cron_jobs", "last_delivered INTEGER");
  ensureColumn(db, "cron_jobs", "last_failure_alert_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "state_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "cron_jobs", "runtime_updated_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "schedule_identity TEXT");
  ensureColumn(db, "cron_jobs", "sort_order INTEGER NOT NULL DEFAULT 0");
  backfillCronJobsFromJobJson(db);
  const addedDeliveryThreadIdType = ensureColumn(db, "cron_jobs", "delivery_thread_id_type TEXT");
  if (addedDeliveryThreadIdType) {
    migrateLegacyCronDeliveryThreadIds(db);
  }
  ensureColumn(db, "sandbox_registry_entries", "session_key TEXT");
  ensureColumn(db, "sandbox_registry_entries", "backend_id TEXT");
  ensureColumn(db, "sandbox_registry_entries", "runtime_label TEXT");
  ensureColumn(db, "sandbox_registry_entries", "image TEXT");
  ensureColumn(db, "sandbox_registry_entries", "created_at_ms INTEGER");
  ensureColumn(db, "sandbox_registry_entries", "last_used_at_ms INTEGER");
  ensureColumn(db, "sandbox_registry_entries", "config_label_kind TEXT");
  ensureColumn(db, "sandbox_registry_entries", "config_hash TEXT");
  ensureColumn(db, "sandbox_registry_entries", "cdp_port INTEGER");
  ensureColumn(db, "sandbox_registry_entries", "no_vnc_port INTEGER");
  ensureColumn(db, "delivery_queue_entries", "entry_kind TEXT");
  ensureColumn(db, "delivery_queue_entries", "session_key TEXT");
  ensureColumn(db, "delivery_queue_entries", "channel TEXT");
  ensureColumn(db, "delivery_queue_entries", "target TEXT");
  ensureColumn(db, "delivery_queue_entries", "account_id TEXT");
  ensureColumn(db, "delivery_queue_entries", "retry_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "delivery_queue_entries", "last_attempt_at INTEGER");
  ensureColumn(db, "delivery_queue_entries", "last_error TEXT");
  ensureColumn(db, "delivery_queue_entries", "recovery_state TEXT");
  ensureColumn(db, "delivery_queue_entries", "platform_send_started_at INTEGER");
  backfillDeliveryQueueEntriesFromEntryJson(db);
  ensureColumn(db, "commitments", "account_id TEXT");
  ensureColumn(db, "commitments", "recipient_id TEXT");
  ensureColumn(db, "commitments", "thread_id TEXT");
  ensureColumn(db, "commitments", "sender_id TEXT");
  ensureColumn(db, "commitments", "kind TEXT NOT NULL DEFAULT 'followup'");
  ensureColumn(db, "commitments", "sensitivity TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, "commitments", "source TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, "commitments", "reason TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "commitments", "suggested_text TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "commitments", "dedupe_key TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "commitments", "confidence REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "commitments", "due_timezone TEXT NOT NULL DEFAULT 'UTC'");
  ensureColumn(db, "commitments", "source_message_id TEXT");
  ensureColumn(db, "commitments", "source_run_id TEXT");
  ensureColumn(db, "commitments", "created_at_ms INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "commitments", "attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "commitments", "last_attempt_at_ms INTEGER");
  ensureColumn(db, "commitments", "sent_at_ms INTEGER");
  ensureColumn(db, "commitments", "dismissed_at_ms INTEGER");
  ensureColumn(db, "commitments", "snoozed_until_ms INTEGER");
  ensureColumn(db, "commitments", "expired_at_ms INTEGER");
  ensureColumn(db, "current_conversation_bindings", "target_agent_id TEXT NOT NULL DEFAULT 'main'");
  ensureColumn(db, "current_conversation_bindings", "target_session_id TEXT");
  ensureColumn(
    db,
    "current_conversation_bindings",
    "conversation_kind TEXT NOT NULL DEFAULT 'channel'",
  );
  ensureColumn(db, "device_bootstrap_tokens", "pending_profile_json TEXT");
  ensureColumn(db, "gateway_restart_handoff", "restart_trace_started_at INTEGER");
  ensureColumn(db, "gateway_restart_handoff", "restart_trace_last_at INTEGER");
  ensureColumn(db, "gateway_restart_intent", "reason TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_channel TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_to TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "delivery_account_id TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "message TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "continuation_json TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "doctor_hint TEXT");
  ensureColumn(db, "gateway_restart_sentinel", "stats_json TEXT");
  ensureColumn(db, "gateway_boot_lifecycle", "startup_reason TEXT");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_mode TEXT");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_key_id TEXT");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_signature_count INTEGER");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_threshold INTEGER");
  ensureColumn(db, "official_external_plugin_catalog_snapshots", "trust_verified_at TEXT");
  const addedTaskRequesterAgentId = ensureColumn(db, "task_runs", "requester_agent_id TEXT");
  if (addedTaskRequesterAgentId) {
    repairLegacyTaskAgentAttribution(db);
  }
  repairLegacyTaskDeliveryStatuses(db);
  ensureColumn(db, "flow_runs", "chain_id TEXT");
  ensureColumn(db, "task_runs", "tool_use_count INTEGER");
  ensureColumn(db, "task_runs", "last_tool_name TEXT");
  ensureColumn(db, "subagent_runs", "task_name TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_bundle_hash TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_openclaw_version TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_protocol_features_json TEXT");
  ensureColumn(
    db,
    "worker_environments",
    "owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0)",
  );
  ensureColumn(db, "worker_environments", "ssh_host_key TEXT");
  ensureColumn(
    db,
    "worker_environments",
    "teardown_terminal_state TEXT CHECK (teardown_terminal_state IN ('destroyed', 'failed'))",
  );
  ensureOperatorApprovalResolutionRefs(db);
}

function ensureSchema(db: DatabaseSync, pathname: string): void {
  const now = Date.now();
  const kysely = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(db);
  runSqliteImmediateTransactionSync(
    db,
    () => {
      assertSupportedSchemaVersion(db, pathname);
      ensureAdditiveStateColumns(db);
      assertCanonicalStateSchemaShape(db, pathname);
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      repairCanonicalSqliteUniqueIndexes(db, pathname, OPENCLAW_STATE_CANONICAL_UNIQUE_INDEXES);
      // Retired node_pairing_* tables were created by earlier schema revisions but
      // never had a shipped writer (the node surface lives on device_pairing_paired
      // records), so dropping the always-empty tables is safe, not destructive.
      db.exec(
        "DROP TABLE IF EXISTS node_pairing_pending; DROP TABLE IF EXISTS node_pairing_paired;",
      );
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("schema_meta")
          .values({
            meta_key: "primary",
            role: "global",
            schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
            agent_id: null,
            app_version: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("meta_key").doUpdateSet({
              role: "global",
              schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
              agent_id: null,
              app_version: null,
              updated_at: now,
            }),
          ),
      );
    },
    {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: pathname,
      operationLabel: "state.schema.ensure",
    },
  );
}

function resolveDatabasePath(options: OpenClawStateDatabaseOptions = {}): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  // A writable handle lets SQLite recover a hot journal or WAL after an
  // interrupted writer. OpenClaw mutations start only after recovery and a
  // full table/index consistency check both succeed.
  assertSqliteIntegrity(database, pathname);
}

/** Open or return a cached shared state database after schema and migration checks. */
export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    return cached;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }

  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
      assertStateDatabaseIntegrityBeforeMutation(db, pathname);
      configureSqlitePreSchemaPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "openclaw-state",
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureSchema(db, pathname);
      return maintenance;
    } catch (err) {
      maintenance?.close();
      db.close();
      throw err;
    }
  })();
  ensureOpenClawStatePermissions(pathname, env);
  const database = { db, path: pathname, walMaintenance };
  cachedDatabases.set(pathname, database);
  return database;
}

/** Run a synchronous immediate transaction against the shared state database. */
export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const database = openOpenClawStateDatabase(options);
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database), {
    busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    databaseLabel: database.path,
    operationLabel: "state.write",
  });
  try {
    ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
  } catch {
    // The write already committed; permission hardening is best-effort here so
    // callers never retry an operation that is durable in SQLite.
  }
  return result;
}

/** Close all cached shared state database handles. */
export function closeOpenClawStateDatabase(): void {
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    if (database.db.isOpen) {
      database.db.close();
    }
  }
  cachedDatabases.clear();
}

/** Test whether any cached shared state database handle is still open. */
export function isOpenClawStateDatabaseOpen(): boolean {
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

/** Test alias for closing shared state handles from teardown code. */
export const closeOpenClawStateDatabaseForTest = closeOpenClawStateDatabase;
