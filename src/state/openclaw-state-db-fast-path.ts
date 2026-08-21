import type { DatabaseSync } from "node:sqlite";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { VERSION } from "../version.js";
import {
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  assertSupportedSchemaVersion,
} from "./openclaw-state-db-maintenance.js";
import { isCanonicalOperatorApprovalKind } from "./openclaw-state-db-operator-approval-migration.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  detectOpenClawStateDatabaseSchemaMigrationsFromDatabase,
  assertCanonicalStateSchemaShape,
} from "./openclaw-state-db-schema-repair.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

function hasRow(database: DatabaseSync, sql: string): boolean {
  return database.prepare(sql).get() !== undefined;
}

function hasPendingOperatorApprovalRepairs(database: DatabaseSync): boolean {
  const rows = database
    .prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals")
    // SAFETY: The selected columns and aliases exactly match this local row shape.
    .all() as Array<{ approval_id: string; kind: unknown; resolution_ref: string | null }>;
  if (
    rows.some(
      (row) =>
        !isCanonicalOperatorApprovalKind(row.kind) ||
        row.resolution_ref !==
          buildApprovalResolutionRef({ approvalId: row.approval_id, approvalKind: row.kind }),
    )
  ) {
    return true;
  }
  return hasRow(
    database,
    `SELECT 1
       FROM operator_approvals AS canonical
       JOIN operator_approvals AS referenced
         ON canonical.approval_id = referenced.resolution_ref
      WHERE canonical.approval_id <> referenced.approval_id
      LIMIT 1`,
  );
}

function hasPendingSameVersionStateRepairs(database: DatabaseSync): boolean {
  if (
    ["cron_run_logs", "database_verifications", "node_pairing_pending", "node_pairing_paired"].some(
      (table) => tableExists(database, table),
    )
  ) {
    return true;
  }
  if (
    hasRow(database, "SELECT 1 FROM task_runs WHERE delivery_status = 'not-requested' LIMIT 1") ||
    hasRow(
      database,
      `SELECT 1 FROM session_watch_cursors
       WHERE watcher_session_key LIKE 'ambient-group-watch:%' LIMIT 1`,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM acp_replay_events WHERE estimated_bytes = 0
       UNION ALL
       SELECT 1 FROM acp_replay_sessions WHERE estimated_bytes = 0
       LIMIT 1`,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM cron_jobs
       WHERE schedule_kind = 'manual' OR payload_kind = 'message' OR name = '' LIMIT 1`,
    ) ||
    hasRow(
      database,
      `SELECT 1 FROM delivery_queue_entries
       WHERE status IN ('pending', 'failed') LIMIT 1`,
    ) ||
    hasPendingOperatorApprovalRepairs(database)
  ) {
    return true;
  }
  return hasRow(
    database,
    `SELECT 1 FROM subagent_runs
     WHERE json_valid(payload_json) AND (
       json_extract(payload_json, '$.delivery.suspendedReason') = 'retry-limit'
       OR json_type(payload_json, '$.startedAt') IS NOT NULL
       OR json_type(payload_json, '$.endedAt') IS NOT NULL
       OR json_type(payload_json, '$.outcome') IS NOT NULL
       OR json_type(payload_json, '$.delivery.payload.frozenResultText') IS NOT NULL
       OR json_type(payload_json, '$.delivery.payload.fallbackFrozenResultText') IS NOT NULL
       OR json_type(pending_final_delivery_payload_json, '$.frozenResultText') IS NOT NULL
       OR json_type(pending_final_delivery_payload_json, '$.fallbackFrozenResultText') IS NOT NULL
     ) LIMIT 1`,
  );
}

export function assertCurrentStateRuntimeSchema(database: DatabaseSync, pathname: string): void {
  assertCanonicalStateSchemaShape(database, pathname);
  assertOpenClawStateDatabaseForMaintenance(database, { pathname });
}

export function isOpenClawStateSchemaFastPathEligible(
  database: DatabaseSync,
  pathname: string,
): boolean {
  assertSupportedSchemaVersion(database, pathname);
  if (readSqliteUserVersion(database) !== OPENCLAW_STATE_SCHEMA_VERSION) {
    return false;
  }
  assertSqliteIntegrity(database, pathname);
  assertCurrentStateRuntimeSchema(database, pathname);
  if (
    collectSqliteSchemaIssues(database, OPENCLAW_STATE_SCHEMA_SQL, {
      allowedMissingTables: LAZY_ADDITIVE_STATE_TABLES,
    }).length > 0 ||
    detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(database, pathname).length > 0 ||
    hasPendingSameVersionStateRepairs(database)
  ) {
    return false;
  }
  const metadata = database
    .prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get();
  return metadata?.app_version === VERSION;
}
