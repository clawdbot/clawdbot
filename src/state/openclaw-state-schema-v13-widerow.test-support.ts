// Historical readers compare complete column definitions, so ALTER ADD defaults
// cannot restore v12's NOT NULL columns; rebuild both exact original contracts.
export const STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL = `
PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TEMP TABLE openclaw_v13_cron_downgrade_preflight (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;
INSERT INTO openclaw_v13_cron_downgrade_preflight (valid)
SELECT json_valid(job_json)
       AND json_type(job_json) = 'object'
       AND json_valid(state_json)
       AND json_type(state_json) = 'object'
  FROM cron_jobs;
DROP TABLE openclaw_v13_cron_downgrade_preflight;

CREATE TABLE cron_jobs_migration_v12 (
  store_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  declaration_key TEXT,
  display_name TEXT,
  owner_agent_id TEXT,
  owner_session_key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL,
  delete_after_run INTEGER,
  created_at_ms INTEGER NOT NULL,
  agent_id TEXT,
  session_key TEXT,
  schedule_kind TEXT NOT NULL,
  schedule_expr TEXT,
  schedule_tz TEXT,
  every_ms INTEGER,
  anchor_ms INTEGER,
  at TEXT,
  stagger_ms INTEGER,
  session_target TEXT NOT NULL,
  wake_mode TEXT NOT NULL,
  trigger_script TEXT,
  trigger_once INTEGER,
  payload_kind TEXT NOT NULL,
  payload_message TEXT,
  payload_model TEXT,
  payload_fallbacks_json TEXT,
  payload_thinking TEXT,
  payload_timeout_seconds INTEGER,
  payload_allow_unsafe_external_content INTEGER,
  payload_external_content_source_json TEXT,
  payload_light_context INTEGER,
  payload_tools_allow_json TEXT,
  payload_tools_allow_is_default INTEGER,
  delivery_mode TEXT,
  delivery_channel TEXT,
  delivery_to TEXT,
  delivery_thread_id TEXT,
  delivery_thread_id_type TEXT,
  delivery_account_id TEXT,
  delivery_best_effort INTEGER,
  delivery_completion_mode TEXT,
  delivery_completion_to TEXT,
  failure_delivery_mode TEXT,
  failure_delivery_channel TEXT,
  failure_delivery_to TEXT,
  failure_delivery_account_id TEXT,
  failure_alert_disabled INTEGER,
  failure_alert_after INTEGER,
  failure_alert_channel TEXT,
  failure_alert_to TEXT,
  failure_alert_cooldown_ms INTEGER,
  failure_alert_include_skipped INTEGER,
  failure_alert_mode TEXT,
  failure_alert_account_id TEXT,
  next_run_at_ms INTEGER,
  running_at_ms INTEGER,
  last_run_at_ms INTEGER,
  last_run_status TEXT,
  last_error TEXT,
  last_duration_ms INTEGER,
  consecutive_errors INTEGER,
  consecutive_skipped INTEGER,
  schedule_error_count INTEGER,
  last_delivery_status TEXT,
  last_delivery_error TEXT,
  last_delivered INTEGER,
  last_failure_alert_at_ms INTEGER,
  job_json TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  runtime_updated_at_ms INTEGER,
  schedule_identity TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_key, job_id)
) STRICT;

INSERT INTO cron_jobs_migration_v12 (
  store_key, job_id, declaration_key, display_name, owner_agent_id,
  owner_session_key, name, description, enabled, delete_after_run, created_at_ms,
  agent_id, session_key, schedule_kind, schedule_expr, schedule_tz, every_ms,
  anchor_ms, at, stagger_ms, session_target, wake_mode, trigger_script, trigger_once,
  payload_kind, payload_message, payload_model, payload_fallbacks_json,
  payload_thinking, payload_timeout_seconds, payload_allow_unsafe_external_content,
  payload_external_content_source_json, payload_light_context, payload_tools_allow_json,
  payload_tools_allow_is_default, delivery_mode, delivery_channel, delivery_to,
  delivery_thread_id, delivery_thread_id_type, delivery_account_id, delivery_best_effort,
  delivery_completion_mode, delivery_completion_to, failure_delivery_mode,
  failure_delivery_channel, failure_delivery_to, failure_delivery_account_id,
  failure_alert_disabled, failure_alert_after, failure_alert_channel, failure_alert_to,
  failure_alert_cooldown_ms, failure_alert_include_skipped, failure_alert_mode,
  failure_alert_account_id, next_run_at_ms, running_at_ms, last_run_at_ms,
  last_run_status, last_error, last_duration_ms, consecutive_errors,
  consecutive_skipped, schedule_error_count, last_delivery_status, last_delivery_error,
  last_delivered, last_failure_alert_at_ms, job_json, state_json, runtime_updated_at_ms,
  schedule_identity, sort_order, updated_at
)
SELECT
  store_key,
  job_id,
  json_extract(job_json, '$.declarationKey'),
  json_extract(job_json, '$.displayName'),
  json_extract(job_json, '$.owner.agentId'),
  json_extract(job_json, '$.owner.sessionKey'),
  json_extract(job_json, '$.name'),
  json_extract(job_json, '$.description'),
  json_extract(job_json, '$.enabled'),
  json_extract(job_json, '$.deleteAfterRun'),
  json_extract(job_json, '$.createdAtMs'),
  json_extract(job_json, '$.agentId'),
  json_extract(job_json, '$.sessionKey'),
  json_extract(job_json, '$.schedule.kind'),
  CASE json_extract(job_json, '$.schedule.kind')
    WHEN 'cron' THEN json_extract(job_json, '$.schedule.expr')
    WHEN 'on-exit' THEN json_extract(job_json, '$.schedule.command')
  END,
  CASE json_extract(job_json, '$.schedule.kind')
    WHEN 'cron' THEN json_extract(job_json, '$.schedule.tz')
    WHEN 'on-exit' THEN json_extract(job_json, '$.schedule.cwd')
  END,
  json_extract(job_json, '$.schedule.everyMs'),
  json_extract(job_json, '$.schedule.anchorMs'),
  json_extract(job_json, '$.schedule.at'),
  json_extract(job_json, '$.schedule.staggerMs'),
  json_extract(job_json, '$.sessionTarget'),
  json_extract(job_json, '$.wakeMode'),
  json_extract(job_json, '$.trigger.script'),
  json_extract(job_json, '$.trigger.once'),
  json_extract(job_json, '$.payload.kind'),
  CASE json_extract(job_json, '$.payload.kind')
    WHEN 'systemEvent' THEN json_extract(job_json, '$.payload.text')
    WHEN 'agentTurn' THEN json_extract(job_json, '$.payload.message')
    WHEN 'command' THEN json_remove(
      json_extract(job_json, '$.payload'),
      '$.kind', '$.timeoutSeconds', '$.toolsAllow', '$.toolsAllowIsDefault'
    )
    WHEN 'script' THEN json_remove(
      json_extract(job_json, '$.payload'),
      '$.kind', '$.timeoutSeconds', '$.toolsAllow', '$.toolsAllowIsDefault'
    )
  END,
  json_extract(job_json, '$.payload.model'),
  CASE WHEN json_type(job_json, '$.payload.fallbacks') = 'array'
    THEN json_extract(job_json, '$.payload.fallbacks')
  END,
  json_extract(job_json, '$.payload.thinking'),
  json_extract(job_json, '$.payload.timeoutSeconds'),
  json_extract(job_json, '$.payload.allowUnsafeExternalContent'),
  CASE WHEN json_type(job_json, '$.payload.externalContentSource') IS NOT NULL
    THEN json_quote(json_extract(job_json, '$.payload.externalContentSource'))
  END,
  json_extract(job_json, '$.payload.lightContext'),
  CASE WHEN json_type(job_json, '$.payload.toolsAllow') = 'array'
    THEN json_extract(job_json, '$.payload.toolsAllow')
  END,
  CASE WHEN json_type(job_json, '$.payload.toolsAllow') = 'array'
    THEN json_extract(job_json, '$.payload.toolsAllowIsDefault')
  END,
  json_extract(job_json, '$.delivery.mode'),
  json_extract(job_json, '$.delivery.channel'),
  json_extract(job_json, '$.delivery.to'),
  CASE WHEN json_type(job_json, '$.delivery.threadId') IN ('integer', 'real', 'text')
    THEN CAST(json_extract(job_json, '$.delivery.threadId') AS TEXT)
  END,
  CASE json_type(job_json, '$.delivery.threadId')
    WHEN 'integer' THEN 'number'
    WHEN 'real' THEN 'number'
    WHEN 'text' THEN 'string'
  END,
  json_extract(job_json, '$.delivery.accountId'),
  json_extract(job_json, '$.delivery.bestEffort'),
  json_extract(job_json, '$.delivery.completionDestination.mode'),
  json_extract(job_json, '$.delivery.completionDestination.to'),
  CASE json_type(job_json, '$.delivery.failureDestination.mode')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.mode')
  END,
  CASE json_type(job_json, '$.delivery.failureDestination.channel')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.channel')
  END,
  CASE json_type(job_json, '$.delivery.failureDestination.to')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.to')
  END,
  CASE json_type(job_json, '$.delivery.failureDestination.accountId')
    WHEN 'null' THEN ''
    WHEN 'text' THEN json_extract(job_json, '$.delivery.failureDestination.accountId')
  END,
  CASE json_type(job_json, '$.failureAlert')
    WHEN 'false' THEN 1
    WHEN 'object' THEN 0
  END,
  json_extract(job_json, '$.failureAlert.after'),
  json_extract(job_json, '$.failureAlert.channel'),
  json_extract(job_json, '$.failureAlert.to'),
  json_extract(job_json, '$.failureAlert.cooldownMs'),
  json_extract(job_json, '$.failureAlert.includeSkipped'),
  json_extract(job_json, '$.failureAlert.mode'),
  json_extract(job_json, '$.failureAlert.accountId'),
  json_extract(state_json, '$.nextRunAtMs'),
  json_extract(state_json, '$.runningAtMs'),
  json_extract(state_json, '$.lastRunAtMs'),
  COALESCE(
    json_extract(state_json, '$.lastRunStatus'),
    json_extract(state_json, '$.lastStatus')
  ),
  json_extract(state_json, '$.lastError'),
  json_extract(state_json, '$.lastDurationMs'),
  json_extract(state_json, '$.consecutiveErrors'),
  json_extract(state_json, '$.consecutiveSkipped'),
  json_extract(state_json, '$.scheduleErrorCount'),
  json_extract(state_json, '$.lastDeliveryStatus'),
  json_extract(state_json, '$.lastDeliveryError'),
  json_extract(state_json, '$.lastDelivered'),
  json_extract(state_json, '$.lastFailureAlertAtMs'),
  job_json,
  state_json,
  runtime_updated_at_ms,
  schedule_identity,
  sort_order,
  updated_at
FROM cron_jobs;

DROP TABLE cron_jobs;
ALTER TABLE cron_jobs_migration_v12 RENAME TO cron_jobs;

CREATE INDEX idx_cron_jobs_store_updated
  ON cron_jobs(store_key, sort_order ASC, updated_at DESC, job_id);
CREATE INDEX idx_cron_jobs_store_order
  ON cron_jobs(store_key, sort_order ASC, updated_at ASC, job_id);
CREATE INDEX idx_cron_jobs_enabled_next_run
  ON cron_jobs(store_key, enabled, next_run_at_ms, job_id)
  WHERE next_run_at_ms IS NOT NULL;
CREATE INDEX idx_cron_jobs_agent_session
  ON cron_jobs(agent_id, session_key, updated_at DESC, job_id)
  WHERE agent_id IS NOT NULL OR session_key IS NOT NULL;

CREATE TABLE subagent_runs_migration_v12 (
  run_id TEXT NOT NULL PRIMARY KEY,
  child_session_key TEXT NOT NULL,
  controller_session_key TEXT,
  requester_session_key TEXT NOT NULL,
  requester_display_key TEXT NOT NULL,
  requester_origin_json TEXT,
  task TEXT NOT NULL,
  task_name TEXT,
  cleanup TEXT NOT NULL,
  label TEXT,
  model TEXT,
  agent_dir TEXT,
  workspace_dir TEXT,
  run_timeout_seconds INTEGER,
  spawn_mode TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  session_started_at INTEGER,
  accumulated_runtime_ms INTEGER,
  ended_at INTEGER,
  outcome_json TEXT,
  archive_at_ms INTEGER,
  cleanup_completed_at INTEGER,
  cleanup_handled INTEGER,
  suppress_announce_reason TEXT,
  expects_completion_message INTEGER,
  announce_retry_count INTEGER,
  last_announce_retry_at INTEGER,
  last_announce_delivery_error TEXT,
  ended_reason TEXT,
  pause_reason TEXT,
  wake_on_descendant_settle INTEGER,
  requester_settle_wake_status TEXT,
  requester_settle_wake_attempt_count INTEGER,
  requester_settle_wake_replay_count INTEGER,
  requester_settle_wake_next_attempt_at INTEGER,
  requester_settle_wake_batch_run_ids_json TEXT,
  requester_settle_wake_last_error TEXT,
  requester_settle_wake_retire_after INTEGER,
  frozen_result_text TEXT,
  frozen_result_captured_at INTEGER,
  fallback_frozen_result_text TEXT,
  fallback_frozen_result_captured_at INTEGER,
  ended_hook_emitted_at INTEGER,
  pending_final_delivery INTEGER,
  pending_final_delivery_created_at INTEGER,
  pending_final_delivery_last_attempt_at INTEGER,
  pending_final_delivery_attempt_count INTEGER,
  pending_final_delivery_last_error TEXT,
  pending_final_delivery_payload_json TEXT,
  completion_announced_at INTEGER,
  swarm_group_id TEXT,
  swarm_collector INTEGER,
  swarm_output_schema_json TEXT,
  swarm_completion_status TEXT,
  swarm_structured_json TEXT,
  swarm_schema_error TEXT,
  swarm_usage_json TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

INSERT INTO subagent_runs_migration_v12 (
  run_id, child_session_key, controller_session_key, requester_session_key,
  requester_display_key, task, cleanup, created_at, payload_json
)
SELECT run_id, child_session_key, controller_session_key, requester_session_key,
  '', '', '', created_at, payload_json
FROM subagent_runs;

DROP TABLE subagent_runs;
ALTER TABLE subagent_runs_migration_v12 RENAME TO subagent_runs;

CREATE INDEX idx_subagent_runs_child_session_key
  ON subagent_runs(child_session_key, created_at DESC, run_id);
CREATE INDEX idx_subagent_runs_requester_session_key
  ON subagent_runs(requester_session_key, created_at DESC, run_id);
CREATE INDEX idx_subagent_runs_controller_session_key
  ON subagent_runs(controller_session_key, created_at DESC, run_id);
CREATE INDEX idx_subagent_runs_archive_at
  ON subagent_runs(archive_at_ms, cleanup_handled, run_id);
CREATE INDEX idx_subagent_runs_ended_cleanup
  ON subagent_runs(ended_at, cleanup_handled, run_id);

CREATE TABLE workspace_attestations (
  workspace_key TEXT NOT NULL PRIMARY KEY,
  attested_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO workspace_attestations (workspace_key, attested_at_ms, updated_at_ms)
SELECT workspace_key, attested_at_ms, attestation_updated_at_ms
FROM workspace_setup_state
WHERE attested_at_ms IS NOT NULL;

CREATE INDEX idx_workspace_attestations_attested
  ON workspace_attestations(attested_at_ms DESC, workspace_key);

-- Data note: v12 requires version/updated_at NOT NULL in the setup table, so
-- merged attestation-only rows (NULL version) survive the downgrade only as
-- workspace_attestations rows, which also own the generated hashes in v12.
DELETE FROM workspace_generated_bootstrap_hashes
WHERE workspace_key NOT IN (SELECT workspace_key FROM workspace_attestations);
DELETE FROM workspace_setup_state WHERE version IS NULL;

CREATE TABLE workspace_setup_state_migration_v12 (
  workspace_key TEXT NOT NULL PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  version INTEGER NOT NULL,
  bootstrap_seeded_at TEXT,
  setup_completed_at TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO workspace_setup_state_migration_v12 (
  workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at
)
SELECT workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at, updated_at
FROM workspace_setup_state;

DROP TABLE workspace_setup_state;
ALTER TABLE workspace_setup_state_migration_v12 RENAME TO workspace_setup_state;

CREATE INDEX idx_workspace_setup_state_path
  ON workspace_setup_state(workspace_path);

CREATE TABLE workspace_generated_bootstrap_hashes_migration_v12 (
  workspace_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (workspace_key, filename),
  FOREIGN KEY (workspace_key) REFERENCES workspace_attestations(workspace_key) ON DELETE CASCADE
) STRICT;

INSERT INTO workspace_generated_bootstrap_hashes_migration_v12 (workspace_key, filename, sha256)
SELECT workspace_key, filename, sha256 FROM workspace_generated_bootstrap_hashes;

DROP TABLE workspace_generated_bootstrap_hashes;
ALTER TABLE workspace_generated_bootstrap_hashes_migration_v12
  RENAME TO workspace_generated_bootstrap_hashes;

-- v12 carried installed_plugin_index; repopulate it from the folded KV row.
CREATE TABLE IF NOT EXISTS installed_plugin_index (
  index_key TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL,
  host_contract_version TEXT NOT NULL,
  compat_registry_version TEXT NOT NULL,
  migration_version INTEGER NOT NULL,
  policy_hash TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  workspace_dir TEXT,
  refresh_reason TEXT,
  install_records_json TEXT NOT NULL,
  plugins_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  warning TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_installed_plugin_index_generated
  ON installed_plugin_index(generated_at_ms DESC, index_key);
INSERT INTO installed_plugin_index (
  index_key, version, host_contract_version, compat_registry_version,
  migration_version, policy_hash, generated_at_ms, workspace_dir, refresh_reason,
  install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
)
SELECT 'installed-plugin-index',
       json_extract(value_json, '$.index.version'),
       json_extract(value_json, '$.index.hostContractVersion'),
       json_extract(value_json, '$.index.compatRegistryVersion'),
       json_extract(value_json, '$.index.migrationVersion'),
       json_extract(value_json, '$.index.policyHash'),
       json_extract(value_json, '$.index.generatedAtMs'),
       json_extract(value_json, '$.index.workspaceDir'),
       json_extract(value_json, '$.index.refreshReason'),
       json_extract(value_json, '$.index.installRecords'),
       json_extract(value_json, '$.index.plugins'),
       json_extract(value_json, '$.index.diagnostics'),
       json_extract(value_json, '$.index.warning'),
       json_extract(value_json, '$.revision')
  FROM config_machine_state
 WHERE state_key = 'plugins.installedIndex';
DELETE FROM config_machine_state WHERE state_key = 'plugins.installedIndex';

-- v12 carried the shared auth singleton tables; repopulate the 'shared' rows
-- from the folded KV cells (value_json is the payload verbatim).
CREATE TABLE IF NOT EXISTS auth_profile_stores (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO auth_profile_stores (store_key, store_json, updated_at)
SELECT 'shared', value_json, updated_at_ms
  FROM config_machine_state
 WHERE state_key = 'authProfiles.store';
CREATE TABLE IF NOT EXISTS auth_profile_state (
  store_key TEXT NOT NULL PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO auth_profile_state (store_key, state_json, updated_at)
SELECT 'shared', value_json, updated_at_ms
  FROM config_machine_state
 WHERE state_key = 'authProfiles.state';
DELETE FROM config_machine_state
 WHERE state_key IN ('authProfiles.store', 'authProfiles.state');

PRAGMA user_version = 12;
UPDATE schema_meta SET schema_version = 12 WHERE meta_key = 'primary';
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
`;
