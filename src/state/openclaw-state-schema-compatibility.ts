import {
  getCanonicalSqliteNamedIndexContracts,
  type SqliteSchemaCompatibility,
  type SqliteSchemaIssue,
} from "../infra/sqlite-schema-contract.js";
import {
  FIRST_USE_STATE_INDEXES,
  FIRST_USE_STATE_TABLES,
  LAZY_ADDITIVE_STATE_INDEXES,
  LAZY_ADDITIVE_STATE_TABLES,
} from "./openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

// Same-version databases may lack additive columns that only a writable open
// can ensure, while read-only planning must keep accepting the older shape.
const CLAW_LAZY_ADDITIVE_STATE_COLUMNS = [
  "claw_installs.bootstrap_content_digest",
  "claw_installs.bootstrap_source_path",
  "worker_environments.desktop_json",
  "claw_package_refs.extension_adapter_identity",
  "claw_package_refs.extension_detected_format",
  "claw_package_refs.extension_format",
  "claw_package_refs.extension_id",
  "claw_package_refs.extension_mapped_json",
  "claw_package_refs.extension_unavailable_json",
  "worker_environments.shared_host",
  "worker_session_placements.terminal_reason",
  "worker_session_placements.terminal_at_ms",
  "worktrees.run_end_cleanup_json",
] as const;

const CLAW_LAZY_ADDITIVE_STATE_COLUMN_SET = new Set<string>(CLAW_LAZY_ADDITIVE_STATE_COLUMNS);
const CLAW_STARTUP_ADDITIVE_STATE_TABLES = [
  "worker_session_tool_operations",
  "worker_turn_tool_authorities",
] as const;
const CLAW_STARTUP_ADDITIVE_STATE_TABLE_SET = new Set<string>(CLAW_STARTUP_ADDITIVE_STATE_TABLES);
let openClawStateCanonicalNamedIndexSet: ReadonlySet<string> | undefined;

function getOpenClawStateCanonicalNamedIndexSet(): ReadonlySet<string> {
  openClawStateCanonicalNamedIndexSet ??= new Set(
    getCanonicalSqliteNamedIndexContracts(OPENCLAW_STATE_SCHEMA_SQL).map((index) => index.name),
  );
  return openClawStateCanonicalNamedIndexSet;
}

/** Project canonical SQL to the tables the shared runtime may create during this open. */
export function getOpenClawStateRuntimeSchema(options: {
  includeVersionLazyAdditiveTables: boolean;
}): string {
  let schema = OPENCLAW_STATE_SCHEMA_SQL;
  const omittedTables = options.includeVersionLazyAdditiveTables
    ? FIRST_USE_STATE_TABLES
    : LAZY_ADDITIVE_STATE_TABLES;
  const omittedIndexes = options.includeVersionLazyAdditiveTables
    ? FIRST_USE_STATE_INDEXES
    : LAZY_ADDITIVE_STATE_INDEXES;
  for (const tableName of omittedTables) {
    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`);
    const endMarker = "\n) STRICT;";
    const end = start >= 0 ? schema.indexOf(endMarker, start) : -1;
    if (start < 0 || end < 0) {
      throw new Error(`lazy additive state schema block is missing for ${tableName}`);
    }
    schema = `${schema.slice(0, start)}${schema.slice(end + endMarker.length)}`;
  }
  for (const indexName of omittedIndexes) {
    const start = schema.indexOf(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    const end = start >= 0 ? schema.indexOf(";", start) : -1;
    if (start < 0 || end < 0) {
      throw new Error(`lazy additive state schema index is missing for ${indexName}`);
    }
    schema = `${schema.slice(0, start)}${schema.slice(end + 1)}`;
  }
  return schema;
}

export const STATE_PERSISTENT_SCHEMA_COMPATIBILITY: SqliteSchemaCompatibility = {
  allowCompatibleAdditiveColumns: true,
  allowedColumnDefinitions: {
    "diagnostic_events.sequence": ["sequence INTEGER NOT NULL DEFAULT 0"],
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
    "claw_package_refs.package_integrity": [
      "package_integrity TEXT NOT NULL DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
    ],
    "claw_package_refs.updated_at_ms": ["updated_at_ms INTEGER NOT NULL DEFAULT 0"],
    "cron_jobs.created_at_ms": ["created_at_ms INTEGER NOT NULL DEFAULT 0"],
    "cron_jobs.enabled": ["enabled INTEGER NOT NULL DEFAULT 1"],
    "cron_jobs.name": ["name TEXT NOT NULL DEFAULT ''"],
    "cron_jobs.payload_kind": ["payload_kind TEXT NOT NULL DEFAULT 'message'"],
    "cron_jobs.schedule_kind": ["schedule_kind TEXT NOT NULL DEFAULT 'manual'"],
    "cron_jobs.session_target": ["session_target TEXT NOT NULL DEFAULT 'main'"],
    "cron_jobs.wake_mode": ["wake_mode TEXT NOT NULL DEFAULT 'auto'"],
    "current_conversation_bindings.conversation_kind": [
      "conversation_kind TEXT NOT NULL DEFAULT 'channel'",
    ],
    "current_conversation_bindings.target_agent_id": [
      "target_agent_id TEXT NOT NULL DEFAULT 'main'",
    ],
    "operator_approvals.resolution_ref": ["resolution_ref TEXT"],
    "worker_environments.desktop_json": ["desktop_json TEXT"],
    "worker_environments.shared_host": ["shared_host INTEGER CHECK (shared_host IN (0, 1))"],
    "worker_session_placements.terminal_reason": ["terminal_reason TEXT"],
    "worker_session_placements.terminal_at_ms": ["terminal_at_ms INTEGER"],
  },
};

export const OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY: SqliteSchemaCompatibility = {
  ...STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
  allowedMissingTables: [...LAZY_ADDITIVE_STATE_TABLES, ...CLAW_STARTUP_ADDITIVE_STATE_TABLES],
  allowedMissingColumns: CLAW_LAZY_ADDITIVE_STATE_COLUMNS,
};

/** Identify schema differences that the writable shared-state cold open repairs. */
export function isOpenClawStateStartupRepairableSchemaIssue(issue: SqliteSchemaIssue): boolean {
  if (issue.code === "missing-table") {
    return CLAW_STARTUP_ADDITIVE_STATE_TABLE_SET.has(issue.objectName);
  }
  if (issue.code === "missing-column") {
    return CLAW_LAZY_ADDITIVE_STATE_COLUMN_SET.has(issue.objectName);
  }
  return (
    issue.code === "missing-or-drifted-index" &&
    getOpenClawStateCanonicalNamedIndexSet().has(issue.objectName)
  );
}
