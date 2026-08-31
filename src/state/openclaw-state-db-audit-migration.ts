import type { DatabaseSync } from "node:sqlite";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  tableExists,
  tableHasColumn,
  tablePrimaryKeyColumns,
} from "./openclaw-state-db-schema-helpers.js";

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

export function hasCanonicalAuditEventsSchema(db: DatabaseSync): boolean {
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

export function canRepairLegacyAuditEventsSchema(db: DatabaseSync): boolean {
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

export function repairAuditEventsSchema(db: DatabaseSync): boolean {
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
