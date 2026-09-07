import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS,
} from "./openclaw-state-db-additive-columns.js";
import {
  backfillAcpReplayEstimatedBytes,
  backfillCronJobsFromJobJson,
  backfillCronRunLogEntryJson,
  backfillDeliveryQueueEntriesFromEntryJson,
  ensureOperatorApprovalResolutionRefs,
  repairLegacyTaskAgentAttribution,
  repairLegacyTaskDeliveryStatuses,
  repairLegacySubagentExecutionPayloads,
  repairLegacySubagentRetainedResults,
  repairLegacySubagentSuspensionReasons,
  repairLegacySubagentTaskBindings,
} from "./openclaw-state-db-legacy-backfills.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const SECRET_STORE_SCHEMA_START = "CREATE TABLE IF NOT EXISTS secret_store_entries (";
const SECRET_STORE_SCHEMA_END =
  "ON secret_store_entries (scope_kind, scope_id, name) WHERE deleted_at_ms IS NULL;";
const MCP_OAUTH_PENDING_SCHEMA_START =
  "CREATE TABLE IF NOT EXISTS mcp_oauth_pending_authorizations (";
const MCP_OAUTH_PENDING_SCHEMA_END = "\n) STRICT;";
const DEVICE_PAIRING_JOIN_CODE_SCHEMA_START =
  "CREATE TABLE IF NOT EXISTS device_pairing_join_codes (";
const DEVICE_PAIRING_JOIN_CODE_SCHEMA_END = "\n) STRICT;";
const CONFIG_REVISION_KEY_SCHEMA_START = "CREATE TABLE IF NOT EXISTS config_revision_keys (";
const CONFIG_REVISION_KEY_SCHEMA_END = "\n) STRICT;";
const repositoryWorkspacePendingSchemas = new WeakSet<DatabaseSync>();

export function hasRepositoryWorkspacePendingResultSchema(database: DatabaseSync): boolean {
  if (repositoryWorkspacePendingSchemas.has(database)) {
    return true;
  }
  const exists = tableHasColumn(
    database,
    "worker_workspace_pending_results",
    "repository_workspace_id",
  );
  // Another process can create the column; cache only committed presence.
  // First-use DDL inside an outer transaction may still roll back.
  if (exists && !database.isTransaction) {
    repositoryWorkspacePendingSchemas.add(database);
  }
  return exists;
}

export function ensureRepositoryWorkspacePendingResultSchema(database: DatabaseSync): void {
  if (!hasRepositoryWorkspacePendingResultSchema(database)) {
    ensureColumn(database, "worker_workspace_pending_results", "repository_workspace_id TEXT");
  }
}

export function ensureSessionRepositoryWorkspaceSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS session_repository_workspaces (",
  );
  const marker = "\n) STRICT;";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
  if (start < 0 || end < start) {
    throw new Error("Repository workspace schema marker is missing.");
  }
  database.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length)); // sqlite-allow-raw -- Canonical first-use DDL; workspace rows use Kysely.
}

export function ensureRepositoryGitHubPublicationSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS github_repository_publication_requests (",
  );
  const marker =
    "ON github_repository_publication_requests(owner_profile_id, session_id, idempotency_key) WHERE owner_profile_id IS NOT NULL;";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
  if (start < 0 || end < start) {
    throw new Error("Repository GitHub publication schema marker is missing.");
  }
  database.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length)); // sqlite-allow-raw -- Canonical first-use DDL; publication rows use Kysely.
}

export function ensureGitHubPublicationSessionLifecycleSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS github_publication_session_lifecycles (",
  );
  const marker = "\n) STRICT;";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
  if (start < 0 || end < start) {
    throw new Error("GitHub publication lifecycle schema marker is missing.");
  }
  database.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length)); // sqlite-allow-raw -- Canonical first-use DDL; bindings use Kysely.
}

function secretStoreSchemaSql(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SECRET_STORE_SCHEMA_START);
  const endMarkerStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SECRET_STORE_SCHEMA_END, start);
  const hasBoundedSchema = start >= 0 && endMarkerStart >= start;
  if (!hasBoundedSchema) {
    throw new Error("OpenClaw secret store schema marker is missing.");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, endMarkerStart + SECRET_STORE_SCHEMA_END.length);
}

/** Lazily install the additive secret store table and index on first write. */
export function ensureSecretStoreSchema(database: DatabaseSync): void {
  database.exec(secretStoreSchemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
  ensureColumn(database, "secret_store_entries", "allowed_hosts TEXT");
}

/** Lazily install durable MCP OAuth callback correlation on first feature use. */
export function ensureMcpOAuthPendingSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(MCP_OAUTH_PENDING_SCHEMA_START);
  const endMarkerStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(MCP_OAUTH_PENDING_SCHEMA_END, start);
  if (start < 0 || endMarkerStart < start) {
    throw new Error("OpenClaw MCP OAuth pending schema marker is missing.");
  }
  database.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(start, endMarkerStart + MCP_OAUTH_PENDING_SCHEMA_END.length),
  ); // sqlite-allow-raw -- Canonical additive DDL only.
}

/** Lazily install the additive device join-code table on first mint or redemption. */
export function ensureDevicePairingJoinCodeSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(DEVICE_PAIRING_JOIN_CODE_SCHEMA_START);
  const endMarkerStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    DEVICE_PAIRING_JOIN_CODE_SCHEMA_END,
    start,
  );
  if (start < 0 || endMarkerStart < start) {
    throw new Error("OpenClaw device pairing join-code schema marker is missing.");
  }
  database.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(
      start,
      endMarkerStart + DEVICE_PAIRING_JOIN_CODE_SCHEMA_END.length,
    ),
  ); // sqlite-allow-raw -- Canonical additive DDL only.
}

/** Lazily installs the Gateway's installation-local config revision key owner. */
export function ensureConfigRevisionKeySchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(CONFIG_REVISION_KEY_SCHEMA_START);
  const endMarkerStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(CONFIG_REVISION_KEY_SCHEMA_END, start);
  if (start < 0 || endMarkerStart < start) {
    throw new Error("OpenClaw config revision key schema marker is missing.");
  }
  database.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(start, endMarkerStart + CONFIG_REVISION_KEY_SCHEMA_END.length),
  ); // sqlite-allow-raw -- Canonical additive DDL only; key rows use Kysely.
}

export function ensureAgentDeletionJournalSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_deletion_journal (
      agent_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL DEFAULT '',
      agent_dir TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      sessions_dir TEXT NOT NULL,
      database_paths_json TEXT NOT NULL DEFAULT '[]',
      cleanup_paths_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      cleanup_completed INTEGER NOT NULL DEFAULT 0,
      delete_files INTEGER NOT NULL DEFAULT 1
    ) STRICT
  `);
}

export function ensureAgentDatabaseLeaseSchema(database: DatabaseSync): void {
  ensureAgentDeletionJournalSchema(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_database_leases (
      lease_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_start_time INTEGER,
      opened_at INTEGER NOT NULL
    ) STRICT
  `);
}

/**
 * Same-version additive table, registered in LAZY_ADDITIVE_STATE_TABLES so
 * existing v6 databases stay valid without it. Mirrors the canonical schema;
 * a downgraded reader simply loses setup-completion reconciliation.
 */
export function ensureDevicePairSetupCompletionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS device_pair_setup_completions (
      setup_id TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL,
      device_name TEXT,
      access TEXT NOT NULL,
      completed_at_ms INTEGER NOT NULL,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('uncertain', 'confirmed')),
      retain_until_ms INTEGER NOT NULL
    ) STRICT
  `);
}

/** Lazily add setup correlation only when setup pairing first writes or consumes a token. */
export function ensureDevicePairSetupBootstrapSchema(database: DatabaseSync): void {
  ensureColumn(database, "device_bootstrap_tokens", "setup_id TEXT");
}

/** Installs environment-owned node binding columns at first cloud enrollment use. */
export function ensureWorkerEnvironmentNodeEnrollmentSchema(database: DatabaseSync): void {
  ensureDevicePairSetupCompletionSchema(database);
  ensureColumn(database, "worker_environments", "node_setup_id TEXT");
  ensureColumn(database, "worker_environments", "node_device_id TEXT");
}

function resolveLegacyManagedImageRoot(recordJson: unknown): string | null {
  if (typeof recordJson !== "string") {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(recordJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(record) || !isRecord(record.original)) {
    return null;
  }
  const mediaRoot = record.original.mediaRoot;
  if (typeof mediaRoot === "string" && mediaRoot.trim()) {
    return path.resolve(mediaRoot);
  }
  const originalPath = record.original.path;
  if (typeof originalPath !== "string" || !originalPath.trim()) {
    return null;
  }
  const resolvedOriginalPath = path.resolve(originalPath);
  return path.dirname(path.dirname(path.dirname(resolvedOriginalPath)));
}

function backfillLegacyManagedImageRoots(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT attachment_id, record_json FROM managed_outgoing_image_records")
    .all() as Array<{ attachment_id: string; record_json: unknown }>;
  const updateRoot = db.prepare(
    "UPDATE managed_outgoing_image_records SET original_media_root = ? WHERE attachment_id = ?",
  );
  const deleteRecord = db.prepare(
    "DELETE FROM managed_outgoing_image_records WHERE attachment_id = ?",
  );
  for (const row of rows) {
    const mediaRoot = resolveLegacyManagedImageRoot(row.record_json);
    if (mediaRoot) {
      updateRoot.run(mediaRoot, row.attachment_id);
    } else {
      // This table had no shipped writer. Discard malformed unexpected rows
      // instead of retaining unusable empty roots or wedging every database open.
      deleteRecord.run(row.attachment_id);
    }
  }
}

function ensureWorkerSessionToolStateSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_turn_tool_authorities (
      session_id TEXT NOT NULL PRIMARY KEY,
      environment_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
      placement_generation INTEGER NOT NULL CHECK (placement_generation >= 0),
      claim_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_names_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES worker_session_placements(session_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS worker_session_tool_operations (
      source_session_id TEXT NOT NULL,
      source_claim_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL CHECK (tool_name IN ('sessions_spawn', 'sessions_send')),
      request_digest TEXT NOT NULL,
      operation_seed TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
      child_session_key TEXT,
      result_json TEXT,
      gateway_instance_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_session_id, source_claim_id, tool_call_id),
      FOREIGN KEY (source_session_id)
        REFERENCES worker_session_placements(session_id) ON DELETE CASCADE
    ) STRICT;
  `);
}

export function ensureGitHubPublicationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_publication_requests (
      request_id TEXT NOT NULL PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      repository_fingerprint TEXT NOT NULL,
      claim_id TEXT,
      run_id TEXT,
      environment_id TEXT,
      owner_epoch INTEGER CHECK (owner_epoch IS NULL OR owner_epoch >= 1),
      placement_generation INTEGER CHECK (
        placement_generation IS NULL OR placement_generation >= 0
      ),
      identity_source TEXT NOT NULL CHECK (
        identity_source IN ('system-detected', 'system-configured', 'agent-override')
      ),
      identity_profile_id TEXT,
      identity_account_id INTEGER NOT NULL CHECK (identity_account_id >= 1),
      identity_login TEXT NOT NULL,
      title TEXT,
      body TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('requested', 'publishing', 'published', 'failed')
      ),
      gateway_instance_id TEXT,
      repository TEXT,
      branch TEXT NOT NULL,
      base_branch TEXT,
      source_head_commit TEXT,
      source_index_tree TEXT,
      workspace_tree TEXT,
      head_commit TEXT,
      pull_request_url TEXT,
      error_code TEXT,
      next_action TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      reported_at_ms INTEGER,
      UNIQUE (session_id, idempotency_key),
      CHECK (
        (claim_id IS NULL AND run_id IS NULL AND environment_id IS NULL
          AND owner_epoch IS NULL AND placement_generation IS NULL)
        OR
        (claim_id IS NOT NULL AND run_id IS NOT NULL AND placement_generation IS NOT NULL
          AND ((environment_id IS NULL AND owner_epoch IS NULL)
            OR (environment_id IS NOT NULL AND owner_epoch IS NOT NULL)))
      ),
      CHECK (
        (identity_source IS 'system-detected' AND identity_profile_id IS NULL)
        OR
        (identity_source IN ('system-configured', 'agent-override')
          AND identity_profile_id IS NOT NULL)
      ),
      CHECK (
        (source_head_commit IS NULL AND source_index_tree IS NULL AND workspace_tree IS NULL)
        OR
        (source_head_commit IS NOT NULL AND workspace_tree IS NOT NULL)
      ),
      CHECK (
        (status IS 'published' AND pull_request_url IS NOT NULL AND error_code IS NULL
          AND next_action IS NULL)
        OR
        (status IS 'failed' AND pull_request_url IS NULL AND error_code IS NOT NULL
          AND next_action IS NOT NULL)
        OR
        (status IN ('requested', 'publishing') AND pull_request_url IS NULL
          AND error_code IS NULL AND next_action IS NULL)
      )
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_github_publication_requests_pending
      ON github_publication_requests(status, updated_at_ms, request_id);
  `);
}

/** First personal publication write only; status and old readers leave this surface dormant. */
export function ensurePersonalGitHubPublicationSchema(db: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS github_personal_publication_requests (",
  );
  const marker = "ON github_personal_publication_requests(status, updated_at_ms, request_id);";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
  if (start < 0 || end < start) {
    throw new Error("Personal GitHub publication schema marker is missing.");
  }
  db.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length)); // sqlite-allow-raw -- Canonical lazy additive DDL only.
}

/**
 * Add the feature-owned first-use columns that a STRICT rebuild cannot skip.
 *
 * These columns normally stay absent until their owning feature first writes
 * them, and the persistent schema contract accepts that shape. The STRICT
 * table rebuild is the one caller that cannot: it recreates each table from
 * canonical SQL, which already declares these columns, so a database missing
 * them fails the canonical column check and rolls the entire repair back.
 * Ensuring them immediately before that rebuild matches the shape the rebuild
 * produces anyway, and stays scoped to databases old enough to need it.
 */
export function ensureFirstUseAdditiveStateColumnsForStrictMigration(db: DatabaseSync): void {
  for (const {
    columnName,
    dataType,
    tableName,
  } of CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
    ensureColumn(db, tableName, `${columnName} ${dataType}`);
  }
}

export function ensureAdditiveStateColumns(db: DatabaseSync): void {
  ensureWorkerSessionToolStateSchema(db);
  for (const {
    columnName,
    dataType,
    tableName,
  } of CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
    ensureColumn(db, tableName, `${columnName} ${dataType}`);
  }
  if (ensureColumn(db, "claw_package_refs", "updated_at_ms INTEGER NOT NULL DEFAULT 0")) {
    db.exec("UPDATE claw_package_refs SET updated_at_ms = installed_at_ms;");
  }
  ensureColumn(
    db,
    "claw_package_refs",
    "package_integrity TEXT NOT NULL DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
  );
  const addedDiagnosticEventSequence = ensureColumn(
    db,
    "diagnostic_events",
    "sequence INTEGER NOT NULL DEFAULT 0",
  );
  if (addedDiagnosticEventSequence) {
    // Preserve the legacy (created_at, rowid) order before the new sequence
    // index becomes authoritative, including stable ties within each scope.
    db.exec(`
      WITH ranked AS (
        SELECT
          rowid AS event_rowid,
          ROW_NUMBER() OVER (
            PARTITION BY scope
            ORDER BY created_at ASC, rowid ASC
          ) AS sequence
        FROM diagnostic_events
      )
      UPDATE diagnostic_events
      SET sequence = (
        SELECT ranked.sequence
        FROM ranked
        WHERE ranked.event_rowid = diagnostic_events.rowid
      );
    `);
  }
  db.exec("DROP INDEX IF EXISTS idx_diagnostic_events_scope_created;");
  ensureColumn(db, "worktrees", "provisioned_paths_json TEXT");
  ensureColumn(db, "apns_registrations", "relay_origin TEXT");
  ensureColumn(db, "device_pairing_pending", "refreshed_at_ms INTEGER");
  ensureColumn(db, "device_pairing_pending", "browser_origin TEXT");
  ensureColumn(db, "device_pairing_paired", "approved_via TEXT");
  ensureColumn(db, "device_pairing_paired", "browser_origin TEXT");
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
  ensureColumn(db, "cron_jobs", "owner_agent_id TEXT");
  ensureColumn(db, "cron_jobs", "name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "cron_jobs", "enabled INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "cron_jobs", "agent_id TEXT");
  ensureColumn(db, "cron_jobs", "payload_kind TEXT NOT NULL DEFAULT 'message'");
  ensureColumn(db, "cron_jobs", "state_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "cron_jobs", "runtime_updated_at_ms INTEGER");
  ensureColumn(db, "cron_jobs", "schedule_identity TEXT");
  ensureColumn(db, "cron_jobs", "sort_order INTEGER NOT NULL DEFAULT 0");
  backfillCronJobsFromJobJson(db);
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
  // The shipped JSON runtime predeclared this table but never populated it.
  // The transitional default makes ADD COLUMN portable; schema-v2 tables are
  // rebuilt from canonical STRICT SQL immediately afterward, removing it.
  const addedOriginalMediaRoot = ensureColumn(
    db,
    "managed_outgoing_image_records",
    "original_media_root TEXT NOT NULL DEFAULT ''",
  );
  if (addedOriginalMediaRoot) {
    backfillLegacyManagedImageRoots(db);
  }
  ensureColumn(db, "managed_outgoing_image_records", "agent_id TEXT");
  ensureColumn(
    db,
    "managed_outgoing_image_records",
    "cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1))",
  );
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
  ensureColumn(db, "task_runs", "tool_use_count INTEGER");
  ensureColumn(db, "task_runs", "last_tool_name TEXT");
  ensureColumn(db, "task_runs", "detail_json TEXT");
  repairLegacySubagentSuspensionReasons(db);
  repairLegacySubagentExecutionPayloads(db);
  repairLegacySubagentTaskBindings(db);
  repairLegacySubagentRetainedResults(db);
  ensureColumn(db, "worker_environments", "bootstrap_bundle_hash TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_openclaw_version TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_protocol_features_json TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_install_kind TEXT");
  ensureColumn(
    db,
    "worker_environments",
    "owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0)",
  );
  ensureColumn(db, "worker_environments", "ssh_host_key TEXT");
  ensureColumn(db, "worker_workspace_pending_results", "staged_result_ref TEXT");
  ensureColumn(
    db,
    "worker_environments",
    "teardown_terminal_state TEXT CHECK (teardown_terminal_state IN ('destroyed', 'failed'))",
  );
  ensureOperatorApprovalResolutionRefs(db);
}
