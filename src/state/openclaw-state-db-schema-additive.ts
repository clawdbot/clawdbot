import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  backfillAcpReplayEstimatedBytes,
  backfillCronJobsFromJobJson,
  backfillCronRunLogEntryJson,
  backfillDeliveryQueueEntriesFromEntryJson,
  ensureOperatorApprovalResolutionRefs,
  migrateLegacyCronDeliveryThreadIds,
  repairLegacyTaskAgentAttribution,
  repairLegacyTaskDeliveryStatuses,
} from "./openclaw-state-db-legacy-backfills.js";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

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

export function ensureAdditiveStateColumns(db: DatabaseSync): void {
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
  ensureColumn(db, "node_host_config", "gateway_context_path TEXT");
  ensureColumn(db, "node_host_config", "installed_apps_sharing INTEGER NOT NULL DEFAULT 0");
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
  ensureColumn(db, "task_runs", "tool_use_count INTEGER");
  ensureColumn(db, "task_runs", "last_tool_name TEXT");
  ensureColumn(db, "task_runs", "detail_json TEXT");
  ensureColumn(db, "subagent_runs", "task_name TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_status TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_attempt_count INTEGER");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_replay_count INTEGER");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_next_attempt_at INTEGER");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_batch_run_ids_json TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_last_error TEXT");
  ensureColumn(db, "subagent_runs", "requester_settle_wake_retire_after INTEGER");
  ensureColumn(db, "subagent_runs", "swarm_group_id TEXT");
  ensureColumn(db, "subagent_runs", "swarm_collector INTEGER");
  ensureColumn(db, "subagent_runs", "swarm_output_schema_json TEXT");
  ensureColumn(db, "subagent_runs", "swarm_completion_status TEXT");
  ensureColumn(db, "subagent_runs", "swarm_structured_json TEXT");
  ensureColumn(db, "subagent_runs", "swarm_schema_error TEXT");
  ensureColumn(db, "subagent_runs", "swarm_usage_json TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_bundle_hash TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_openclaw_version TEXT");
  ensureColumn(db, "worker_environments", "bootstrap_protocol_features_json TEXT");
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
