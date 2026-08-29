import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteSchemaContains,
  collectSqliteNamedIndexContract,
  collectSqliteSchemaIssues,
  getCanonicalSqliteNamedIndexContracts,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

const stateDbLog = createSubsystemLogger("state/db");
export const logRetiredStateTableMigration = (message: string) => stateDbLog.info(message);

export const RETIRED_COMMITMENTS_SCHEMA_VERSION = 7;

export const RETIRED_DEAD_STATE_TABLES_V10 = [
  "agent_model_catalogs",
  "android_notification_recent_packages",
  "command_log_entries",
  "diagnostic_stability_bundles",
  "media_blobs",
  "model_capability_cache",
] as const;
const RETIRED_COMMITMENTS_COLUMNS_SQL = `
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
`;

const RETIRED_COMMITMENTS_BASE_INDEXES_SQL = `CREATE INDEX idx_commitments_scope_due
  ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
CREATE INDEX idx_commitments_status_due
  ON commitments(status, due_earliest_ms, due_latest_ms);
CREATE INDEX idx_commitments_scope_dedupe
  ON commitments(agent_id, session_key, channel, dedupe_key, status);`;

// Canonical v7-era shape: STRICT typing plus the two indexes added after the
// table shipped. Index fingerprints below are derived from this exact text.
const RETIRED_COMMITMENTS_SCHEMA_SQL = `
CREATE TABLE commitments (${RETIRED_COMMITMENTS_COLUMNS_SQL.slice(1, -1)}
) STRICT;
${RETIRED_COMMITMENTS_BASE_INDEXES_SQL}
CREATE INDEX idx_commitments_agent_due
  ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
CREATE INDEX idx_commitments_agent_sent
  ON commitments(agent_id, status, sent_at_ms, session_key);
`;

// The non-STRICT shape older releases actually wrote, without the later indexes.
const SHIPPED_RETIRED_COMMITMENTS_SCHEMA_SQL = `
CREATE TABLE commitments (${RETIRED_COMMITMENTS_COLUMNS_SQL.slice(1, -1)}
);
${RETIRED_COMMITMENTS_BASE_INDEXES_SQL}
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
    // SAFETY: sqlite_schema projection returns exactly the selected text columns.
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

export function hasRecognizedRetiredCommitmentsSchema(db: DatabaseSync): boolean {
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
    // SAFETY: sqlite_schema projection returns exactly the selected name column.
    .all() as Array<{ name: string }>;
  for (const table of tables) {
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(table.name)})`)
      // SAFETY: PRAGMA foreign_key_list rows are widened to unknown before use.
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
        // SAFETY: sqlite_schema projection returns exactly the selected text columns.
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
    // SAFETY: sqlite_schema projection returns exactly the selected name column.
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

function migrateRetiredCommitmentsSchema(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= RETIRED_COMMITMENTS_SCHEMA_VERSION) {
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

function migrateRetiredDeadStateTablesV10(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 10) {
    return false;
  }
  // These tables shipped without writers except for rebuildable model-catalog
  // cache rows, so unlike commitments they need no shape or dependency proof.
  let dropped = false;
  for (const tableName of RETIRED_DEAD_STATE_TABLES_V10) {
    if (tableExists(db, tableName)) {
      db.exec(`DROP TABLE IF EXISTS ${tableName};`);
      dropped = true;
    }
  }
  return dropped;
}

export const RETIRED_SKILL_CURATOR_TABLES_V11 = [
  "skill_lifecycle",
  "skill_workshop_proposal_origin_runs",
] as const;

function migrateRetiredSkillCuratorTablesV11(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 11) {
    return false;
  }
  const retiredTables = RETIRED_SKILL_CURATOR_TABLES_V11.filter((table) => tableExists(db, table));
  if (retiredTables.length === 0) {
    return false;
  }
  if (retiredTables.includes("skill_lifecycle")) {
    const archivedCount = Number(
      db
        .prepare("SELECT COUNT(*) AS archived_count FROM skill_lifecycle WHERE state = 'archived'")
        .get()?.archived_count,
    );
    // Archiving hid skills from every snapshot, so dropping the table changes what
    // the operator sees; say so rather than silently widening the collection.
    if (archivedCount > 0) {
      stateDbLog.info(
        `${archivedCount} previously archived workshop skills return to the active collection; the weekly collection review will judge them`,
      );
    }
  }
  // Lifecycle rows are legacy v2026.7.1 sweep state; proposal origin runs were never read.
  for (const table of retiredTables) {
    db.exec(`DROP TABLE IF EXISTS ${table};`);
  }
  return true;
}

/**
 * Runs every retired-table migration in schema order and names what it changed.
 * Both the repair path and the ordinary open path go through here so the order
 * and the operator-visible labels cannot drift apart.
 */
export function runRetiredStateTableMigrations(
  db: DatabaseSync,
  previousVersion: number,
): string[] {
  const applied: string[] = [];
  if (migrateRetiredCommitmentsSchema(db, previousVersion)) {
    applied.push("Discarded retired shared-state commitments rows, table, and indexes");
  }
  if (migrateRetiredDeadStateTablesV10(db, previousVersion)) {
    applied.push("Retired six dead shared-state tables (v10)");
  }
  if (migrateRetiredSkillCuratorTablesV11(db, previousVersion)) {
    applied.push("Retired legacy skill curator lifecycle and proposal origin-run tables");
  }
  return applied;
}
