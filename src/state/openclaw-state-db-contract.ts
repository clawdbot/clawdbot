import type { DatabaseSync } from "node:sqlite";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";

// v6 makes every committed shared-state table part of the canonical runtime schema.
// v5 records durable cloud-worker result refs on pending workspace fences.
export const OPENCLAW_STATE_SCHEMA_VERSION = 6;
export const OPENCLAW_STATE_STRICT_SCHEMA_VERSION = 3;
// Privacy-sensitive feature tables remain absent even in fresh databases until
// their feature-local first write. The canonical SQL still owns their shape.
export const FIRST_USE_STATE_TABLES = [
  "execution_identity_contexts",
  "operator_approval_execution_identities",
] as const;
export const FIRST_USE_STATE_INDEXES = ["execution_identity_contexts_run_created_idx"] as const;
// Added after v6 shipped. These tables stay optional until their feature-local
// lazy ensures run; fold them into the next natural schema-version bump.
export const LAZY_ADDITIVE_STATE_TABLES = [
  ...FIRST_USE_STATE_TABLES,
  "model_catalog_remote",
  "secret_store_entries",
  "projects",
  "gateway_origin_device_tokens",
  "sidebar_sections",
  "skill_workshop_proposal_events",
  "skill_workshop_proposal_origin_runs",
  "skill_workshop_proposal_rollbacks",
  "skill_workshop_proposals",
  "worker_environment_ssh_fallback_ports",
] as const;
export const LAZY_ADDITIVE_STATE_INDEXES = [
  ...FIRST_USE_STATE_INDEXES,
  "secret_store_entries_live_idx",
] as const;
/** Maximum time one synchronous SQLite call may wait for a lock. */
export const OPENCLAW_SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** User-facing guide for schema refusals; lives here so error sites avoid import cycles. */
export const OPENCLAW_DATABASE_SCHEMA_DOCS_URL =
  "https://docs.openclaw.ai/reference/database-schemas";

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
  database?: OpenClawStateDatabase;
  readOnly?: boolean;
};
export type OpenClawStateDatabaseSchemaMigration = {
  kind:
    | "agent-databases-composite-primary-key"
    | "audit-events-v2"
    | "operator-approvals-system-agent"
    | "session-watch-cursor-provenance-v4"
    | "strict-tables-v3";
  path: string;
};
