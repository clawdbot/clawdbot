// Doctor-only repair for the operator approval kind constraint.
import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

const COLUMNS = [
  "approval_id",
  "resolution_ref",
  "kind",
  "status",
  "presentation_json",
  "requested_by_device_id",
  "requested_by_client_id",
  "requested_by_device_token_auth",
  "reviewer_device_ids_json",
  "source_agent_id",
  "source_session_key",
  "source_session_id",
  "source_run_id",
  "source_tool_call_id",
  "source_tool_name",
  "audience_session_keys_json",
  "runtime_epoch",
  "created_at_ms",
  "expires_at_ms",
  "updated_at_ms",
  "decision",
  "terminal_reason",
  "resolved_at_ms",
  "resolver_kind",
  "resolver_id",
  "consumed_at_ms",
  "consumed_by",
] as const;

function tableSql(db: DatabaseSync): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operator_approvals'")
    .get() as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" ? row.sql : undefined;
}

function hasCanonicalOperatorApprovalKinds(db: DatabaseSync): boolean {
  if (!tableExists(db, "operator_approvals")) {
    return true;
  }
  return /kind\s+text\s+not\s+null\s+check\s*\(\s*kind\s+in\s*\(\s*'exec'\s*,\s*'plugin'\s*,\s*'system-agent'\s*\)\s*\)/.test(
    tableSql(db)?.toLowerCase() ?? "",
  );
}

export function assertCanonicalOperatorApprovalKinds(db: DatabaseSync, pathname: string): void {
  if (!hasCanonicalOperatorApprovalKinds(db)) {
    throw new Error(
      `OpenClaw state database ${pathname} has a legacy operator approval schema; run openclaw doctor --fix to migrate it.`,
    );
  }
}

export function isCanonicalOperatorApprovalKind(
  value: unknown,
): value is "exec" | "plugin" | "system-agent" {
  return value === "exec" || value === "plugin" || value === "system-agent";
}

export function detectOperatorApprovalSchemaMigration(db: DatabaseSync, path: string) {
  return hasCanonicalOperatorApprovalKinds(db)
    ? []
    : [{ kind: "operator-approvals-system-agent" as const, path }];
}

function normalizeDdl(sql: string): string {
  // sqlite_master stores the CREATE statement without a trailing semicolon.
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function canonicalOperatorApprovalCreateSql(): string {
  const marker = "CREATE TABLE IF NOT EXISTS operator_approvals (";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "\n);\n\nCREATE INDEX IF NOT EXISTS idx_operator_approvals_status_expiry",
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error("canonical operator approval schema is unavailable");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + 3);
}

// The only legacy shape this repair may destructively replace is the exact
// prior canonical table with the two-kind constraint (before 'system-agent').
// Matching column names alone is not fail-closed: a table with the same names
// but different constraints/defaults/types would get its rows copied under a
// schema that silently discards those semantics.
function hasExactLegacyOperatorApprovalSchema(db: DatabaseSync): boolean {
  const live = tableSql(db);
  if (!live) {
    return false;
  }
  const expectedLegacy = normalizeDdl(
    canonicalOperatorApprovalCreateSql()
      // sqlite_master stores the CREATE statement without "IF NOT EXISTS".
      .replace(
        "CREATE TABLE IF NOT EXISTS operator_approvals (",
        "CREATE TABLE operator_approvals (",
      )
      .replace(/'exec',\s*'plugin',\s*'system-agent'/, "'exec', 'plugin'"),
  );
  return normalizeDdl(live) === expectedLegacy;
}

function canonicalCreateSql(): string {
  return canonicalOperatorApprovalCreateSql().replace(
    "CREATE TABLE IF NOT EXISTS operator_approvals (",
    "CREATE TABLE operator_approvals_migration_new (",
  );
}

function repairOperatorApprovalKinds(db: DatabaseSync): boolean {
  if (
    hasCanonicalOperatorApprovalKinds(db) ||
    tableExists(db, "operator_approvals_migration_new") ||
    !hasExactLegacyOperatorApprovalSchema(db)
  ) {
    return false;
  }
  const columns = COLUMNS.join(", ");
  // The copy/drop/rename must be atomic: a crash after DROP but before RENAME
  // would strand the rows in the temp table, and the next schema bootstrap would
  // recreate an empty canonical table and abandon them.
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(canonicalCreateSql());
    db.exec(`
      INSERT INTO operator_approvals_migration_new (${columns})
      SELECT ${columns} FROM operator_approvals;
      DROP TABLE operator_approvals;
      ALTER TABLE operator_approvals_migration_new RENAME TO operator_approvals;
    `);
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  });
  return true;
}

export function repairOperatorApprovalSchema(db: DatabaseSync): string[] {
  return repairOperatorApprovalKinds(db)
    ? ["Migrated shared state operator approvals → OpenClaw system changes"]
    : [];
}
