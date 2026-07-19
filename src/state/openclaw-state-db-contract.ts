import type { DatabaseSync } from "node:sqlite";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";

// v5 records durable cloud-worker result refs on pending workspace fences.
export const OPENCLAW_STATE_SCHEMA_VERSION = 5;
export const OPENCLAW_STATE_STRICT_SCHEMA_VERSION = 3;
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
