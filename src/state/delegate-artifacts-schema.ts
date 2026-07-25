// Additive feature-local schema for managed delegate-return artifact claims.
export const DELEGATE_ARTIFACTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS delegate_artifact_policies (
  flow_id TEXT NOT NULL PRIMARY KEY,
  producer_session_key TEXT NOT NULL,
  producer_session_id TEXT,
  producer_run_id TEXT NOT NULL UNIQUE,
  origin_parent_session_key TEXT NOT NULL,
  origin_parent_session_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version = 1),
  dispatch_revision INTEGER NOT NULL,
  dispatch_accepted_at INTEGER NOT NULL,
  scheduled_at INTEGER,
  not_before INTEGER,
  artifact_mode TEXT NOT NULL CHECK (artifact_mode IN ('optional', 'required')),
  recipient_context TEXT,
  recipients_json TEXT NOT NULL,
  route_json TEXT NOT NULL,
  output_root TEXT NOT NULL,
  max_artifact_count INTEGER NOT NULL,
  max_artifact_bytes INTEGER NOT NULL,
  max_total_bytes INTEGER NOT NULL,
  allowed_mimes_json TEXT NOT NULL,
  retention_deadline INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'staged', 'completed', 'failed')),
  completion_id TEXT,
  completion_finalization_key TEXT,
  completed_at INTEGER,
  completion_status TEXT,
  completion_delivery_mode TEXT CHECK (
    completion_delivery_mode IS NULL OR completion_delivery_mode IN ('announced', 'silent')
  ),
  completion_disposition TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_delegate_artifact_policies_producer
  ON delegate_artifact_policies(producer_run_id, status);

CREATE INDEX IF NOT EXISTS idx_delegate_artifact_policies_retention
  ON delegate_artifact_policies(retention_deadline);

CREATE TABLE IF NOT EXISTS delegate_artifact_claims (
  claim_id TEXT NOT NULL PRIMARY KEY,
  flow_id TEXT NOT NULL,
  publication_key TEXT NOT NULL,
  publication_index INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  backing BLOB,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'staged', 'available', 'expired', 'revoked', 'orphaned', 'purged')
  ),
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  UNIQUE (flow_id, ordinal),
  UNIQUE (flow_id, publication_key, publication_index),
  FOREIGN KEY (flow_id) REFERENCES delegate_artifact_policies(flow_id) ON DELETE CASCADE,
  CHECK (backing IS NULL OR length(backing) = size_bytes)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_delegate_artifact_claims_flow
  ON delegate_artifact_claims(flow_id, status, ordinal);

CREATE TABLE IF NOT EXISTS delegate_artifact_recipient_outcomes (
  flow_id TEXT NOT NULL,
  recipient_session_key TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  recipient_relation TEXT NOT NULL CHECK (recipient_relation IN ('parent', 'inter_session')),
  purpose TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('available', 'unavailable')),
  unavailable_reason TEXT,
  decided_at INTEGER NOT NULL,
  first_delivery_at INTEGER,
  replayed_at INTEGER,
  delivery_acknowledged_at INTEGER,
  delivery_terminal_reason TEXT,
  PRIMARY KEY (flow_id, recipient_session_key, recipient_session_id),
  FOREIGN KEY (flow_id) REFERENCES delegate_artifact_policies(flow_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS delegate_artifact_bindings (
  claim_id TEXT NOT NULL,
  recipient_session_key TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  recipient_relation TEXT NOT NULL CHECK (recipient_relation IN ('parent', 'inter_session')),
  purpose TEXT,
  status TEXT NOT NULL CHECK (status IN ('available', 'materialized', 'discarded', 'unavailable')),
  unavailable_reason TEXT,
  arrived_at INTEGER,
  replayed_at INTEGER,
  materialized_at INTEGER,
  discarded_at INTEGER,
  last_delivery_attempt_at INTEGER,
  delivery_acknowledged_at INTEGER,
  PRIMARY KEY (claim_id, recipient_session_key, recipient_session_id),
  FOREIGN KEY (claim_id) REFERENCES delegate_artifact_claims(claim_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_delegate_artifact_bindings_recipient
  ON delegate_artifact_bindings(
    recipient_session_key,
    recipient_session_id,
    status,
    arrived_at,
    claim_id
  );

CREATE TABLE IF NOT EXISTS delegate_artifact_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  claim_id TEXT,
  flow_id TEXT,
  recipient_session_key TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  destination TEXT,
  occurred_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_delegate_artifact_audit_recipient
  ON delegate_artifact_audit(recipient_session_key, recipient_session_id, occurred_at, sequence);
`;
