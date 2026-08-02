/**
 * This file was generated from the SQLite schema source.
 * Please do not edit it manually.
 */

export const DURABLE_RUNTIME_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS durable_execution_records (
  runtime_run_id TEXT NOT NULL PRIMARY KEY,
  operation_kind TEXT NOT NULL,
  operation_version TEXT NOT NULL DEFAULT '1',
  idempotency_key TEXT,
  request_hash TEXT,
  status TEXT NOT NULL,
  source_owner TEXT,
  source_ref TEXT,
  input_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  recovery_state TEXT NOT NULL DEFAULT 'runnable',
  checkpoint_ref TEXT,
  parent_runtime_run_id TEXT,
  parent_step_id TEXT,
  message_id TEXT,
  turn_id TEXT,
  work_unit_id TEXT,
  report_route_id TEXT,
  heartbeat_at INTEGER,
  metadata_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_execution_records_idempotency
  ON durable_execution_records(operation_kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_durable_execution_records_status
  ON durable_execution_records(status, updated_at, runtime_run_id);

CREATE INDEX IF NOT EXISTS idx_durable_execution_records_work_unit
  ON durable_execution_records(work_unit_id, updated_at, runtime_run_id)
  WHERE work_unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_durable_execution_records_report_route
  ON durable_execution_records(report_route_id, updated_at, runtime_run_id)
  WHERE report_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_durable_execution_records_source
  ON durable_execution_records(source_owner, source_ref, updated_at, runtime_run_id)
  WHERE source_owner IS NOT NULL AND source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS durable_event_evidence (
  event_id TEXT NOT NULL UNIQUE,
  runtime_run_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  step_id TEXT,
  agent_invocation_id TEXT,
  tool_invocation_id TEXT,
  idempotency_key TEXT,
  payload_json TEXT,
  payload_hash TEXT,
  checkpoint_ref TEXT,
  causation_event_id TEXT,
  correlation_id TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (runtime_run_id, event_seq),
  FOREIGN KEY (runtime_run_id) REFERENCES durable_execution_records(runtime_run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_durable_event_evidence_type
  ON durable_event_evidence(event_type, event_time, runtime_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_event_evidence_idempotency
  ON durable_event_evidence(runtime_run_id, event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS durable_execution_steps (
  runtime_run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  parent_step_id TEXT,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL,
  recovery_state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER,
  idempotency_key TEXT,
  input_ref TEXT,
  output_ref TEXT,
  error_ref TEXT,
  checkpoint_ref TEXT,
  claimed_by TEXT,
  claim_expires_at INTEGER,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  metadata_json TEXT,
  PRIMARY KEY (runtime_run_id, step_id),
  FOREIGN KEY (runtime_run_id) REFERENCES durable_execution_records(runtime_run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_durable_execution_steps_status
  ON durable_execution_steps(status, updated_at, runtime_run_id, step_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_execution_steps_idempotency
  ON durable_execution_steps(runtime_run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS durable_payload_refs (
  ref_id TEXT NOT NULL PRIMARY KEY,
  runtime_run_id TEXT NOT NULL,
  step_id TEXT,
  ref_kind TEXT NOT NULL,
  media_type TEXT,
  hash TEXT,
  storage_kind TEXT NOT NULL,
  storage_uri TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (runtime_run_id) REFERENCES durable_execution_records(runtime_run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_durable_payload_refs_run
  ON durable_payload_refs(runtime_run_id, ref_kind, created_at);

CREATE TABLE IF NOT EXISTS durable_run_correlations (
  parent_runtime_run_id TEXT NOT NULL,
  parent_step_id TEXT NOT NULL,
  child_runtime_run_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (parent_runtime_run_id, parent_step_id, child_runtime_run_id),
  FOREIGN KEY (parent_runtime_run_id) REFERENCES durable_execution_records(runtime_run_id)
    ON DELETE CASCADE,
  FOREIGN KEY (child_runtime_run_id) REFERENCES durable_execution_records(runtime_run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_durable_run_correlations_child
  ON durable_run_correlations(child_runtime_run_id, status);

CREATE TABLE IF NOT EXISTS durable_timer_obligations (
  timer_id TEXT NOT NULL PRIMARY KEY,
  runtime_run_id TEXT NOT NULL,
  step_id TEXT,
  timer_type TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER,
  cancelled_at INTEGER,
  metadata_json TEXT,
  FOREIGN KEY (runtime_run_id) REFERENCES durable_execution_records(runtime_run_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_durable_timer_obligations_due
  ON durable_timer_obligations(status, due_at, timer_id);

CREATE TABLE IF NOT EXISTS durable_signal_evidence (
  signal_id TEXT NOT NULL PRIMARY KEY,
  runtime_run_id TEXT NOT NULL,
  step_id TEXT,
  signal_type TEXT NOT NULL,
  idempotency_key TEXT,
  payload_ref TEXT,
  correlation_id TEXT,
  received_at INTEGER NOT NULL,
  consumed_at INTEGER,
  metadata_json TEXT,
  FOREIGN KEY (runtime_run_id) REFERENCES durable_execution_records(runtime_run_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_signal_evidence_idempotency
  ON durable_signal_evidence(runtime_run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_durable_signal_evidence_pending
  ON durable_signal_evidence(consumed_at, received_at, signal_id);

CREATE TABLE IF NOT EXISTS wake_obligations (
  wake_id TEXT NOT NULL PRIMARY KEY,
  source_owner TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  parent_run_id TEXT,
  parent_session_key TEXT,
  target_agent TEXT,
  target_session TEXT,
  target_channel TEXT,
  target_kind TEXT,
  target_ref TEXT,
  owner_kind TEXT,
  owner_ref TEXT,
  report_route_ref TEXT,
  target_resolution_status TEXT,
  target_resolution_reason TEXT,
  reason TEXT NOT NULL,
  facts_ref TEXT,
  source_run_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  acked_at INTEGER,
  failed_reason TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_wake_obligations_status
  ON wake_obligations(status, updated_at, wake_id);

CREATE INDEX IF NOT EXISTS idx_wake_obligations_source
  ON wake_obligations(source_owner, source_ref, updated_at, wake_id);

CREATE TABLE IF NOT EXISTS uncertainty_facts (
  fact_id TEXT NOT NULL PRIMARY KEY,
  source_owner TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_run_id TEXT,
  step_id TEXT,
  event_id TEXT,
  ref_id TEXT,
  facts_ref TEXT,
  dedupe_key TEXT UNIQUE,
  facts_json TEXT,
  status TEXT NOT NULL,
  resolution_kind TEXT,
  resolution_ref TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_uncertainty_facts_status
  ON uncertainty_facts(status, updated_at, fact_id);

CREATE INDEX IF NOT EXISTS idx_uncertainty_facts_source
  ON uncertainty_facts(source_owner, source_ref, updated_at, fact_id);

CREATE TABLE IF NOT EXISTS delivery_attempt_evidence (
  delivery_attempt_id TEXT NOT NULL PRIMARY KEY,
  wake_id TEXT NOT NULL,
  source_owner TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  replay_pass_id TEXT,
  target_kind TEXT,
  target_ref TEXT,
  route_kind TEXT,
  route_ref TEXT,
  status TEXT NOT NULL,
  evidence_json TEXT,
  error_message TEXT,
  scheduled_at INTEGER NOT NULL,
  attempted_at INTEGER,
  handoff_accepted_at INTEGER,
  failed_at INTEGER,
  unknown_at INTEGER,
  delivery_claimed_by TEXT,
  delivery_claim_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (wake_id) REFERENCES wake_obligations(wake_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempt_evidence_status
  ON delivery_attempt_evidence(status, scheduled_at, delivery_attempt_id);

CREATE INDEX IF NOT EXISTS idx_delivery_attempt_evidence_source
  ON delivery_attempt_evidence(source_owner, source_ref, scheduled_at, delivery_attempt_id);\n`;
