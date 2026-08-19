-- Session storage doctrine: session_nodes.entry_json is the canonical logical-session
-- record. Promoted session_nodes columns are query indexes projected only by the
-- session entry writer; session_windows and their children own transcript generations.

CREATE TABLE IF NOT EXISTS schema_meta (
  meta_key TEXT NOT NULL PRIMARY KEY,
  role TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_id TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS state_leases (
  scope TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER,
  heartbeat_at INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, lease_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_state_leases_expiry
  ON state_leases(expires_at, scope, lease_key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_state_leases_owner
  ON state_leases(owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_nodes (
  session_key TEXT NOT NULL PRIMARY KEY,
  current_session_id TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  entry_valid INTEGER NOT NULL DEFAULT 0 CHECK (entry_valid IN (-1, 0, 1)),
  updated_at INTEGER NOT NULL,
  status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
  created_at INTEGER,
  created_via TEXT CHECK (created_via IS NULL OR created_via IN ('operator', 'spawn', 'channel', 'cron', 'talk', 'run', 'plugin', 'internal')),
  created_actor_type TEXT CHECK (created_actor_type IS NULL OR created_actor_type IN ('human', 'agent', 'system')),
  created_actor_id TEXT,
  parent_session_key TEXT,
  spawned_by TEXT,
  fork_source_session_key TEXT,
  fork_source_session_id TEXT,
  fork_source_entry_id TEXT,
  label TEXT,
  display_name TEXT,
  category TEXT,
  icon TEXT,
  pinned_at INTEGER,
  archived_at INTEGER,
  last_read_at INTEGER,
  last_interaction_at INTEGER,
  last_activity_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_updated_at
  ON session_nodes(updated_at DESC, session_key);

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_last_interaction_at
  ON session_nodes(last_interaction_at DESC, session_key);

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_parent_session_key
  ON session_nodes(parent_session_key, session_key);

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_spawned_by
  ON session_nodes(spawned_by, session_key);

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_status
  ON session_nodes(status, session_key)
  WHERE status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_archived_at
  ON session_nodes(archived_at, session_key)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_current_session_id
  ON session_nodes(current_session_id);

CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_entry_valid_pending
  ON session_nodes(session_key)
  WHERE entry_valid = 0;

-- Write-once memory provenance for one logical session. Current authority is
-- rechecked in shared state; this row is never rewritten to chase a later
-- principal, binding, or session-window mapping.
CREATE TABLE IF NOT EXISTS session_memory_subjects (
  session_key TEXT NOT NULL PRIMARY KEY,
  binding_id TEXT,
  principal_id TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'user', 'conversation', 'service', 'agent', 'system', 'ambiguous', 'quarantined'
  )),
  subject_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (
    (subject_kind = 'user' AND binding_id IS NOT NULL AND principal_id IS NOT NULL)
    OR
    (subject_kind IN ('conversation', 'service', 'agent', 'system') AND binding_id IS NULL AND principal_id IS NOT NULL)
    OR
    (subject_kind IN ('ambiguous', 'quarantined') AND binding_id IS NULL AND principal_id IS NULL)
  )
) STRICT;

-- A logical node keeps one immutable subject. Every session-id window gets an
-- immutable snapshot of that subject so reset/rebind races cannot silently
-- inherit authority from a different generation.
CREATE TABLE IF NOT EXISTS session_memory_subject_snapshots (
  session_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  subject_revision TEXT NOT NULL,
  session_identity_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_key) REFERENCES session_memory_subjects(session_key)
) STRICT;

CREATE TRIGGER IF NOT EXISTS session_memory_subjects_immutable
BEFORE UPDATE ON session_memory_subjects
BEGIN
  SELECT RAISE(ABORT, 'session memory subject is immutable');
END;

CREATE TRIGGER IF NOT EXISTS session_memory_subject_snapshots_immutable
BEFORE UPDATE ON session_memory_subject_snapshots
BEGIN
  SELECT RAISE(ABORT, 'session memory subject snapshot is immutable');
END;

CREATE TABLE IF NOT EXISTS session_key_contract (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  main_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);

CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_insert
AFTER INSERT ON session_nodes
BEGIN
  UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
END;

CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_entry_update
AFTER UPDATE OF entry_json ON session_nodes
BEGIN
  UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
END;

CREATE TRIGGER IF NOT EXISTS session_nodes_entry_valid_after_identity_update
AFTER UPDATE OF current_session_id, updated_at ON session_nodes
BEGIN
  UPDATE session_nodes SET entry_valid = 0 WHERE session_key = NEW.session_key;
END;

CREATE TABLE IF NOT EXISTS session_windows (
  session_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  previous_session_id TEXT,
  reason TEXT CHECK (reason IS NULL OR reason IN ('initial', 'reset', 'rollover', 'fork', 'rewind', 'switch', 'recovery', 'compaction')),
  session_scope TEXT NOT NULL DEFAULT 'conversation' CHECK (session_scope IN ('conversation', 'shared-main', 'group', 'channel')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  transcript_updated_at INTEGER DEFAULT NULL,
  transcript_observed_at INTEGER DEFAULT NULL,
  session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1)),
  acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1)),
  plugin_owner_id TEXT,
  hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook')),
  started_at INTEGER,
  ended_at INTEGER,
  status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
  chat_type TEXT CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'channel')),
  channel TEXT,
  account_id TEXT,
  primary_conversation_id TEXT,
  model_provider TEXT,
  model TEXT,
  agent_harness_id TEXT,
  parent_session_key TEXT,
  spawned_by TEXT,
  display_name TEXT,
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE,
  FOREIGN KEY (primary_conversation_id) REFERENCES conversations(conversation_id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_session_windows_updated_at
  ON session_windows(updated_at DESC, session_id);

CREATE INDEX IF NOT EXISTS idx_agent_session_windows_created_at
  ON session_windows(created_at DESC, session_id);

CREATE INDEX IF NOT EXISTS idx_agent_session_windows_conversation
  ON session_windows(primary_conversation_id, updated_at DESC, session_id)
  WHERE primary_conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT NOT NULL PRIMARY KEY,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'channel')),
  peer_id TEXT NOT NULL,
  delivery_target TEXT NOT NULL,
  parent_conversation_id TEXT,
  thread_id TEXT,
  native_channel_id TEXT,
  native_direct_user_id TEXT,
  label TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_conversations_lookup
  ON conversations(channel, account_id, kind, peer_id, thread_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_conversations_identity
  ON conversations(
    channel,
    account_id,
    kind,
    peer_id,
    IFNULL(parent_conversation_id, ''),
    IFNULL(thread_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_agent_conversations_updated
  ON conversations(updated_at DESC, conversation_id);

CREATE TABLE IF NOT EXISTS conversation_deliveries (
  operation_id TEXT NOT NULL PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('send', 'turn')),
  conversation_id TEXT NOT NULL,
  source_session_key TEXT,
  message_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'queued', 'sent', 'suppressed', 'rejected', 'unknown', 'replied')),
  prepared_message_id TEXT,
  platform_message_id TEXT,
  queue_id TEXT,
  rejection_error TEXT,
  reply_message_id TEXT,
  reply_to_id TEXT,
  reply_thread_id TEXT,
  reply_text TEXT,
  reply_timestamp INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'rejected' AND rejection_error IS NOT NULL) OR
    (status != 'rejected' AND rejection_error IS NULL)
  ),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_conversation_deliveries_reply
  ON conversation_deliveries(conversation_id, platform_message_id, prepared_message_id)
  WHERE status IN ('queued', 'sent', 'replied');

CREATE INDEX IF NOT EXISTS idx_agent_conversation_deliveries_updated
  ON conversation_deliveries(updated_at DESC, operation_id);

CREATE TABLE IF NOT EXISTS session_conversations (
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'participant', 'related')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, conversation_id, role),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_session_conversations_conversation
  ON session_conversations(conversation_id, last_seen_at DESC, session_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_session_conversations_primary
  ON session_conversations(session_id)
  WHERE role = 'primary';

CREATE TABLE IF NOT EXISTS session_members (
  session_key TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, identity_id),
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_session_members_identity
  ON session_members(identity_id, session_key);

CREATE TABLE IF NOT EXISTS session_suggestions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_label TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'dismissed')),
  dispatch_token TEXT,
  dispatch_started_at INTEGER,
  dispatch_resolution TEXT CHECK (dispatch_resolution IN ('send', 'queue', 'edit', 'dismiss')),
  CHECK (
    (dispatch_token IS NULL AND dispatch_started_at IS NULL AND dispatch_resolution IS NULL)
    OR (dispatch_token IS NOT NULL AND dispatch_started_at IS NOT NULL AND dispatch_resolution IS NOT NULL)
  ),
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_session_suggestions_session_state_created
  ON session_suggestions(session_key, state, created_at, id);

CREATE INDEX IF NOT EXISTS idx_agent_session_suggestions_author_created
  ON session_suggestions(author_id, created_at, id);

CREATE TABLE IF NOT EXISTS board_tabs (
  session_key TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  chat_dock TEXT NOT NULL DEFAULT 'right' CHECK (chat_dock IN ('left', 'right', 'bottom', 'hidden')),
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (session_key, tab_id),
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS board_widgets (
  session_key TEXT NOT NULL,
  name TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  title TEXT,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('html', 'mcp-app', 'plugin')),
  html BLOB,
  descriptor_json TEXT,
  sha256 TEXT NOT NULL,
  view_generation TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  size_w INTEGER NOT NULL CHECK (size_w BETWEEN 1 AND 12),
  size_h INTEGER NOT NULL CHECK (size_h BETWEEN 1 AND 20),
  position INTEGER NOT NULL CHECK (position >= 0),
  manifest TEXT NOT NULL DEFAULT '{}',
  grant_state TEXT NOT NULL DEFAULT 'none' CHECK (grant_state IN ('none', 'pending', 'granted', 'rejected')),
  granted_sha TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, name),
  FOREIGN KEY (session_key, tab_id) REFERENCES board_tabs(session_key, tab_id) ON DELETE CASCADE,
  CHECK (
    (content_kind = 'html' AND html IS NOT NULL AND descriptor_json IS NULL AND view_generation IS NOT NULL) OR
    (content_kind = 'mcp-app' AND html IS NULL AND descriptor_json IS NOT NULL AND view_generation IS NULL) OR
    (content_kind = 'plugin' AND html IS NULL AND descriptor_json IS NOT NULL AND view_generation IS NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_board_widgets_tab_position
  ON board_widgets(session_key, tab_id, position);

CREATE TABLE IF NOT EXISTS heartbeat_outcomes (
  session_key TEXT NOT NULL PRIMARY KEY,
  run_session_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('progress', 'done', 'blocked', 'needs_attention')),
  summary TEXT NOT NULL,
  response_reason TEXT,
  priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high')),
  next_check TEXT,
  task_names_json TEXT,
  wake_source TEXT,
  wake_reason TEXT,
  occurred_at INTEGER NOT NULL,
  context_run_id TEXT,
  context_claimed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS transcript_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS transcript_rewrite_watermarks (
  session_id TEXT NOT NULL PRIMARY KEY,
  generation TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS trajectory_runtime_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  run_id TEXT,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_trajectory_runtime_run
  ON trajectory_runtime_events(session_id, run_id, seq)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS acp_parent_stream_events (
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, run_id, seq),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_acp_parent_stream_run
  ON acp_parent_stream_events(run_id, seq);

CREATE TABLE IF NOT EXISTS transcript_event_identities (
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT,
  parent_id TEXT,
  message_idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, event_id),
  FOREIGN KEY (session_id, seq) REFERENCES transcript_events(session_id, seq) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_transcript_message_idempotency
  ON transcript_event_identities(session_id, message_idempotency_key)
  WHERE message_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_parent
  ON transcript_event_identities(session_id, parent_id)
  WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_sequence
  ON transcript_event_identities(session_id, event_type, seq DESC);

CREATE TABLE IF NOT EXISTS context_engine_turn_outbox (
  advancement_key TEXT NOT NULL PRIMARY KEY,
  engine_id TEXT NOT NULL,
  owner_plugin_id TEXT,
  session_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_context_engine_turn_outbox_engine
  ON context_engine_turn_outbox(engine_id, created_at);

CREATE TABLE IF NOT EXISTS cache_entries (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  blob BLOB,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_cache_expiry
  ON cache_entries(scope, expires_at, key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_cache_updated
  ON cache_entries(scope, updated_at DESC, key);

CREATE TABLE IF NOT EXISTS auth_profile_store (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS auth_profile_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_sources (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  mtime REAL NOT NULL,
  size INTEGER NOT NULL,
  UNIQUE (path, source)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_chunk_recall_metadata (
  chunk_id TEXT PRIMARY KEY,
  importance INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),
  triggers TEXT,
  project_key TEXT,
  FOREIGN KEY (chunk_id) REFERENCES memory_index_chunks(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_chunk_provenance (
  chunk_id TEXT PRIMARY KEY,
  origin_class TEXT NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
  session_kind TEXT NOT NULL CHECK (session_kind IN ('interactive', 'cron', 'heartbeat', 'subagent', 'unknown')),
  observed_at INTEGER NOT NULL,
  supersedes_key TEXT,
  FOREIGN KEY (chunk_id) REFERENCES memory_index_chunks(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS memory_embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
) STRICT;

-- Scoped memory is additive and feature-local. Existing agent databases do
-- not create this group until the scoped backend is selected.
CREATE TABLE IF NOT EXISTS memory_storage_roots (
  storage_root_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('builtin', 'alternate')),
  opaque_locator TEXT NOT NULL,
  path_key_version INTEGER NOT NULL CHECK (path_key_version > 0),
  path_key TEXT,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('user', 'conversation', 'role', 'agent-shared', 'agent', 'internal')),
  authority_owner_id TEXT NOT NULL,
  default_capabilities_json TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('pending', 'active', 'quarantined', 'tombstoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((backend_kind = 'builtin' AND path_key IS NOT NULL) OR backend_kind <> 'builtin'),
  UNIQUE (agent_id, opaque_locator),
  UNIQUE (agent_id, path_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_storage_roots_agent_state
  ON memory_storage_roots(agent_id, lifecycle_state, storage_root_id);

CREATE TABLE IF NOT EXISTS memory_stores (
  store_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  storage_root_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'conversation', 'role', 'agent-shared', 'agent', 'internal')),
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('user', 'conversation', 'role', 'agent-shared', 'agent', 'internal')),
  audience_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('pending', 'active', 'quarantined', 'tombstoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (storage_root_id) REFERENCES memory_storage_roots(storage_root_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_id) REFERENCES memory_policies(policy_id) ON DELETE RESTRICT,
  UNIQUE (agent_id, storage_root_id, scope_kind, audience_kind, audience_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_stores_agent_scope
  ON memory_stores(agent_id, scope_kind, audience_kind, audience_id, lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_memory_stores_policy
  ON memory_stores(agent_id, policy_id, lifecycle_state, store_id);

CREATE TABLE IF NOT EXISTS memory_policies (
  policy_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  revocation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_policies_agent_state
  ON memory_policies(agent_id, lifecycle_state, policy_id);

CREATE TABLE IF NOT EXISTS memory_policy_revisions (
  revision_id TEXT NOT NULL PRIMARY KEY,
  policy_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  revocation_epoch INTEGER NOT NULL CHECK (revocation_epoch >= 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'superseded', 'revoked')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'service', 'system', 'unattributed')),
  actor_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES memory_policies(policy_id) ON DELETE RESTRICT,
  UNIQUE (policy_id, revision_number)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_policy_revisions_one_active
  ON memory_policy_revisions(policy_id)
  WHERE lifecycle_state = 'active';

CREATE TRIGGER IF NOT EXISTS memory_policy_revisions_immutable_fields
BEFORE UPDATE OF policy_id, revision_number, revocation_epoch, actor_kind, actor_id, reason, created_at
ON memory_policy_revisions
BEGIN
  SELECT RAISE(ABORT, 'memory policy revision fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_policy_revisions_no_delete
BEFORE DELETE ON memory_policy_revisions
BEGIN
  SELECT RAISE(ABORT, 'memory policy revisions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS memory_policy_revisions_terminal_lifecycle
BEFORE UPDATE OF lifecycle_state ON memory_policy_revisions
WHEN old.lifecycle_state <> 'active' AND new.lifecycle_state <> old.lifecycle_state
BEGIN
  SELECT RAISE(ABORT, 'retired memory policy revisions cannot be reactivated');
END;

CREATE TABLE IF NOT EXISTS memory_policy_entries (
  entry_id TEXT NOT NULL PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('placement', 'exception', 'publish')),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  principal_id TEXT NOT NULL,
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('user', 'conversation', 'role', 'agent-shared', 'agent', 'internal', '*')),
  audience_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('retrieve', 'read', 'append', 'replace', 'derive', 'deposit', 'project', 'publish', 'import', 'export', 'delete', 'sync', 'status', 'policy-admin')),
  grantor_principal_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (policy_revision_id) REFERENCES memory_policy_revisions(revision_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_policy_entries_revision_operation
  ON memory_policy_entries(policy_revision_id, operation, effect, principal_id);

CREATE TRIGGER IF NOT EXISTS memory_policy_entries_no_update
BEFORE UPDATE ON memory_policy_entries
BEGIN
  SELECT RAISE(ABORT, 'memory policy entries are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_policy_entries_no_delete
BEFORE DELETE ON memory_policy_entries
BEGIN
  SELECT RAISE(ABORT, 'memory policy entries cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS memory_resources (
  resource_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  logical_locator TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory' CHECK (source IN ('memory', 'sessions')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (store_id) REFERENCES memory_stores(store_id) ON DELETE RESTRICT,
  UNIQUE (agent_id, store_id, logical_locator)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_resources_agent_store
  ON memory_resources(agent_id, store_id, resource_id);

CREATE TABLE IF NOT EXISTS memory_resource_revisions (
  revision_id TEXT NOT NULL PRIMARY KEY,
  resource_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  artifact_locator TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
  policy_revision_id TEXT NOT NULL,
  policy_revocation_epoch INTEGER NOT NULL CHECK (policy_revocation_epoch >= 0),
  source_policy_set_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('pending', 'active', 'quarantined', 'tombstoned')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'service', 'system', 'unattributed')),
  actor_id TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  FOREIGN KEY (resource_id) REFERENCES memory_resources(resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_revision_id) REFERENCES memory_policy_revisions(revision_id) ON DELETE RESTRICT,
  UNIQUE (resource_id, revision_number),
  UNIQUE (resource_id, artifact_locator)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_resource_revisions_one_active
  ON memory_resource_revisions(resource_id)
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_resource_revisions_policy
  ON memory_resource_revisions(policy_revision_id, lifecycle_state, revision_id);

CREATE TRIGGER IF NOT EXISTS memory_resource_revisions_immutable_fields
BEFORE UPDATE OF resource_id, revision_number, artifact_locator, content_hash, content_bytes, policy_revision_id, policy_revocation_epoch, source_policy_set_id, actor_kind, actor_id, expires_at, created_at
ON memory_resource_revisions
BEGIN
  SELECT RAISE(ABORT, 'memory resource revision fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_resource_revisions_no_delete
BEFORE DELETE ON memory_resource_revisions
BEGIN
  SELECT RAISE(ABORT, 'memory resource revisions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS memory_resource_revisions_terminal_lifecycle
BEFORE UPDATE OF lifecycle_state ON memory_resource_revisions
WHEN old.lifecycle_state = 'tombstoned' AND new.lifecycle_state <> old.lifecycle_state
BEGIN
  SELECT RAISE(ABORT, 'tombstoned memory resource revisions cannot be reactivated');
END;

CREATE TABLE IF NOT EXISTS memory_resource_subjects (
  revision_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('person', 'project', 'conversation', 'topic')),
  subject_id TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('current', 'superseded')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (revision_id, subject_kind, subject_id),
  FOREIGN KEY (revision_id) REFERENCES memory_resource_revisions(revision_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_resource_subjects_lookup
  ON memory_resource_subjects(subject_kind, subject_id, lifecycle_state, revision_id);

CREATE TABLE IF NOT EXISTS memory_scoped_chunks (
  chunk_key INTEGER PRIMARY KEY,
  chunk_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL,
  chunk_ordinal INTEGER NOT NULL CHECK (chunk_ordinal >= 0),
  start_line INTEGER NOT NULL CHECK (start_line > 0),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (revision_id) REFERENCES memory_resource_revisions(revision_id) ON DELETE RESTRICT,
  UNIQUE (revision_id, chunk_ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_scoped_chunks_revision
  ON memory_scoped_chunks(revision_id, chunk_ordinal);

CREATE TABLE IF NOT EXISTS memory_scoped_chunk_vectors (
  chunk_id TEXT NOT NULL PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK (dims > 0),
  embedding TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES memory_scoped_chunks(chunk_id) ON DELETE CASCADE
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_scoped_chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  revision_id UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_scoped_chunks_fts_after_insert
AFTER INSERT ON memory_scoped_chunks
BEGIN
  INSERT INTO memory_scoped_chunks_fts(rowid, text, chunk_id, revision_id, start_line, end_line)
  VALUES (new.chunk_key, new.text, new.chunk_id, new.revision_id, new.start_line, new.end_line);
END;

CREATE TRIGGER IF NOT EXISTS memory_scoped_chunks_fts_after_delete
AFTER DELETE ON memory_scoped_chunks
BEGIN
  DELETE FROM memory_scoped_chunks_fts WHERE rowid = old.chunk_key;
END;

CREATE TRIGGER IF NOT EXISTS memory_scoped_chunks_fts_after_update
AFTER UPDATE OF text, chunk_id, revision_id, start_line, end_line ON memory_scoped_chunks
BEGIN
  DELETE FROM memory_scoped_chunks_fts WHERE rowid = old.chunk_key;
  INSERT INTO memory_scoped_chunks_fts(rowid, text, chunk_id, revision_id, start_line, end_line)
  VALUES (new.chunk_key, new.text, new.chunk_id, new.revision_id, new.start_line, new.end_line);
END;

-- A write intent commits before its revision is readable. Opaque locators are
-- basenames below the selected store root, never caller-controlled paths.
CREATE TABLE IF NOT EXISTS memory_write_intents (
  intent_id TEXT NOT NULL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('remember', 'append', 'replace', 'delete', 'tombstone', 'derive', 'deposit', 'project', 'publish', 'import', 'sync', 'admin-reclassify')),
  store_id TEXT NOT NULL,
  resource_id TEXT,
  pending_revision_id TEXT,
  staged_locator TEXT,
  final_locator TEXT,
  content_hash TEXT,
  content_bytes INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'renamed', 'active', 'quarantined', 'tombstoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  activated_at INTEGER,
  indexed_at INTEGER,
  FOREIGN KEY (store_id) REFERENCES memory_stores(store_id) ON DELETE RESTRICT,
  FOREIGN KEY (resource_id) REFERENCES memory_resources(resource_id) ON DELETE RESTRICT,
  FOREIGN KEY (pending_revision_id) REFERENCES memory_resource_revisions(revision_id) ON DELETE RESTRICT,
  UNIQUE (agent_id, idempotency_key),
  UNIQUE (agent_id, mutation_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_write_intents_recovery
  ON memory_write_intents(agent_id, state, created_at, intent_id);

CREATE TRIGGER IF NOT EXISTS memory_write_intents_immutable_identity
BEFORE UPDATE OF intent_id, idempotency_key, mutation_id, agent_id, request_id, run_id,
  context_fingerprint, plan_id, mutation_kind, store_id, resource_id, pending_revision_id,
  staged_locator, final_locator, content_hash, content_bytes
ON memory_write_intents
BEGIN
  SELECT RAISE(ABORT, 'memory write intent identity is immutable');
END;

-- Local audit records commit with the lifecycle. Retrying delivery is safe and
-- delivery never becomes an authorization condition for a memory mutation.
CREATE TABLE IF NOT EXISTS memory_audit_outbox (
  event_id TEXT NOT NULL PRIMARY KEY,
  intent_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  operation TEXT NOT NULL,
  resource_revision_id TEXT,
  content_hash TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'committed', 'quarantined', 'tombstoned')),
  reason_code TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER,
  FOREIGN KEY (intent_id) REFERENCES memory_write_intents(intent_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_audit_outbox_drain
  ON memory_audit_outbox(agent_id, state, created_at, event_id);

CREATE TRIGGER IF NOT EXISTS memory_audit_outbox_immutable_identity
BEFORE UPDATE OF event_id, intent_id, agent_id, request_id, run_id, actor_ref, subject_ref,
  operation, resource_revision_id, content_hash, created_at
ON memory_audit_outbox
BEGIN
  SELECT RAISE(ABORT, 'memory audit outbox identity is immutable');
END;

CREATE TABLE IF NOT EXISTS memory_migrations (
  migration_id TEXT NOT NULL PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('previewed', 'backed-up', 'copied', 'indexed', 'verified', 'cutover')),
  classification_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  verified_at INTEGER,
  cutover_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_kind, source_hash)
) STRICT;

-- Transcript memory policy labels are additive and lazily ensured with the scoped-memory group.
-- They make a missing authorization receipt a durable deny rather than an unlabeled transcript copy.
CREATE TABLE IF NOT EXISTS memory_policy_sets (
  policy_set_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  memory_policy_revision TEXT NOT NULL,
  member_policy_set_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS memory_policy_sets_no_update
BEFORE UPDATE ON memory_policy_sets
BEGIN
  SELECT RAISE(ABORT, 'memory policy sets are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_policy_sets_no_delete
BEFORE DELETE ON memory_policy_sets
BEGIN
  SELECT RAISE(ABORT, 'memory policy sets cannot be deleted');
END;

-- A policy-set id is an immutable retention handle, not an everlasting grant.
-- Its members retain the stable policy identity and the exact active revision
-- expected at exposure time; readers revalidate both against current policy state.
CREATE TABLE IF NOT EXISTS memory_policy_set_members (
  policy_set_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  expected_revision_id TEXT NOT NULL,
  expected_revocation_epoch INTEGER NOT NULL CHECK (expected_revocation_epoch >= 0),
  audience_intersection_json TEXT NOT NULL,
  retention_state TEXT NOT NULL CHECK (retention_state IN ('retained', 'quarantined')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (policy_set_id, policy_id),
  FOREIGN KEY (policy_set_id) REFERENCES memory_policy_sets(policy_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_id) REFERENCES memory_policies(policy_id) ON DELETE RESTRICT,
  FOREIGN KEY (expected_revision_id) REFERENCES memory_policy_revisions(revision_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_policy_set_members_policy
  ON memory_policy_set_members(policy_id, expected_revision_id, expected_revocation_epoch);

CREATE TRIGGER IF NOT EXISTS memory_policy_set_members_no_update
BEFORE UPDATE ON memory_policy_set_members
BEGIN
  SELECT RAISE(ABORT, 'memory policy set members are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_policy_set_members_no_delete
BEFORE DELETE ON memory_policy_set_members
BEGIN
  SELECT RAISE(ABORT, 'memory policy set members cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS memory_run_exposures (
  exposure_set_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  previous_exposure_set_id TEXT,
  source_policy_set_ids_json TEXT NOT NULL,
  effective_source_policy_set_id TEXT NOT NULL,
  exposed_resource_revisions_json TEXT NOT NULL,
  exposure_receipt_ids_json TEXT NOT NULL,
  egress_receipt_ids_json TEXT NOT NULL,
  delivery_audiences_json TEXT NOT NULL,
  delivery_revision TEXT NOT NULL,
  egress_registry_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, revision_number),
  FOREIGN KEY (previous_exposure_set_id) REFERENCES memory_run_exposures(exposure_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (effective_source_policy_set_id) REFERENCES memory_policy_sets(policy_set_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_run_exposures_run
  ON memory_run_exposures(run_id, revision_number DESC);

CREATE TRIGGER IF NOT EXISTS memory_run_exposures_no_update
BEFORE UPDATE ON memory_run_exposures
BEGIN
  SELECT RAISE(ABORT, 'memory run exposures are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_run_exposures_no_delete
BEFORE DELETE ON memory_run_exposures
BEGIN
  SELECT RAISE(ABORT, 'memory run exposures cannot be deleted');
END;

-- Resource-to-exposure rows make revocation and expiry impact analysis a
-- durable join, rather than an opaque array scan over transcript history.
CREATE TABLE IF NOT EXISTS memory_run_exposure_resources (
  exposure_set_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  policy_set_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (exposure_set_id, resource_revision_id),
  FOREIGN KEY (exposure_set_id) REFERENCES memory_run_exposures(exposure_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (resource_revision_id) REFERENCES memory_resource_revisions(revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_set_id) REFERENCES memory_policy_sets(policy_set_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_run_exposure_resources_revision
  ON memory_run_exposure_resources(resource_revision_id, exposure_set_id);

CREATE TRIGGER IF NOT EXISTS memory_run_exposure_resources_no_update
BEFORE UPDATE ON memory_run_exposure_resources
BEGIN
  SELECT RAISE(ABORT, 'memory run exposure resources are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_run_exposure_resources_no_delete
BEFORE DELETE ON memory_run_exposure_resources
BEGIN
  SELECT RAISE(ABORT, 'memory run exposure resources cannot be deleted');
END;

-- Selected-plugin content is never returned until this content-free ledger row commits.
-- It is lazy/additive so current-version databases remain compatible until first scoped read.
CREATE TABLE IF NOT EXISTS memory_preoutput_exposure_ledger (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  exposure_set_id TEXT NOT NULL UNIQUE,
  previous_exposure_set_id TEXT,
  session_key TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  memory_policy_revision TEXT NOT NULL,
  source_policy_set_ids_json TEXT NOT NULL,
  exposed_resource_revisions_json TEXT NOT NULL,
  exposure_receipt_ids_json TEXT NOT NULL,
  egress_receipt_ids_json TEXT NOT NULL,
  delivery_audiences_json TEXT NOT NULL,
  delivery_revision TEXT NOT NULL,
  egress_registry_revision TEXT NOT NULL,
  session_identity_revision TEXT NOT NULL,
  subject_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, session_id, run_id, revision_number),
  FOREIGN KEY (previous_exposure_set_id) REFERENCES memory_preoutput_exposure_ledger(exposure_set_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_preoutput_exposure_ledger_session_run
  ON memory_preoutput_exposure_ledger(agent_id, session_id, run_id, revision_number DESC);

CREATE TRIGGER IF NOT EXISTS memory_preoutput_exposure_ledger_no_update
BEFORE UPDATE ON memory_preoutput_exposure_ledger
BEGIN
  SELECT RAISE(ABORT, 'pre-output memory exposure ledger is immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_preoutput_exposure_ledger_no_delete
BEFORE DELETE ON memory_preoutput_exposure_ledger
BEGIN
  SELECT RAISE(ABORT, 'pre-output memory exposure ledger cannot be deleted');
END;

-- Trusted host facts are captured before content release. Keep their audit-only
-- projection separate from the old ledger table so existing agent databases can
-- install it lazily without a schema-version migration.
CREATE TABLE IF NOT EXISTS memory_preoutput_exposure_authorization_facts (
  exposure_set_id TEXT NOT NULL PRIMARY KEY,
  actor_evidence_json TEXT NOT NULL,
  delegation_snapshot_json TEXT NOT NULL,
  host_facts_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (exposure_set_id)
    REFERENCES memory_preoutput_exposure_ledger(exposure_set_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER IF NOT EXISTS memory_preoutput_exposure_authorization_facts_no_update
BEFORE UPDATE ON memory_preoutput_exposure_authorization_facts
BEGIN
  SELECT RAISE(ABORT, 'pre-output exposure authorization facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_preoutput_exposure_authorization_facts_no_delete
BEFORE DELETE ON memory_preoutput_exposure_authorization_facts
BEGIN
  SELECT RAISE(ABORT, 'pre-output exposure authorization facts cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS transcript_event_memory_policies (
  session_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  authorization_status TEXT NOT NULL CHECK (authorization_status IN ('authorized', 'pending')),
  source_policy_set_id TEXT,
  run_exposure_set_id TEXT,
  run_exposure_revision INTEGER,
  delivery_audiences_json TEXT,
  session_identity_revision TEXT,
  subject_revision TEXT,
  run_id TEXT,
  context_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, event_seq),
  FOREIGN KEY (session_id, event_seq) REFERENCES transcript_events(session_id, seq) ON DELETE CASCADE,
  FOREIGN KEY (source_policy_set_id) REFERENCES memory_policy_sets(policy_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_exposure_set_id) REFERENCES memory_run_exposures(exposure_set_id) ON DELETE RESTRICT,
  CHECK (
    (authorization_status = 'authorized'
      AND source_policy_set_id IS NOT NULL
      AND run_exposure_set_id IS NOT NULL
      AND run_exposure_revision IS NOT NULL
      AND delivery_audiences_json IS NOT NULL
      AND session_identity_revision IS NOT NULL
      AND subject_revision IS NOT NULL
      AND run_id IS NOT NULL
      AND context_fingerprint IS NOT NULL)
    OR
    (authorization_status = 'pending'
      AND source_policy_set_id IS NULL
      AND run_exposure_set_id IS NULL
      AND run_exposure_revision IS NULL
      AND delivery_audiences_json IS NULL
      AND session_identity_revision IS NULL
      AND subject_revision IS NULL
      AND run_id IS NULL
      AND context_fingerprint IS NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_event_memory_policies_status
  ON transcript_event_memory_policies(session_id, authorization_status, event_seq);

-- The narrow P1C row remains the hot replay filter. This companion holds the
-- full opaque retention evidence without making transcript JSON authoritative.
CREATE TABLE IF NOT EXISTS transcript_event_memory_policy_details (
  session_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  actor_evidence_json TEXT NOT NULL,
  delegation_snapshot_json TEXT NOT NULL,
  exposed_resource_revisions_json TEXT NOT NULL,
  exposure_receipt_ids_json TEXT NOT NULL,
  egress_receipt_ids_json TEXT NOT NULL,
  normalized_audience_intersection_json TEXT NOT NULL,
  finalized_delivery_audiences_json TEXT NOT NULL,
  retention_state TEXT NOT NULL CHECK (retention_state IN ('retained', 'quarantined')),
  source_session_id TEXT NOT NULL,
  source_event_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, event_seq),
  FOREIGN KEY (session_id, event_seq)
    REFERENCES transcript_event_memory_policies(session_id, event_seq) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_event_memory_policy_details_source
  ON transcript_event_memory_policy_details(source_session_id, source_event_seq);

CREATE TRIGGER IF NOT EXISTS transcript_event_memory_policy_details_no_update
BEFORE UPDATE ON transcript_event_memory_policy_details
BEGIN
  SELECT RAISE(ABORT, 'transcript memory policy details are immutable');
END;

-- The immutable detail lives exactly as long as its transcript event. The
-- transcript owner deletes both through the foreign-key cascade during a
-- reset/rewind/replace; blocking that cascade would leave the session unable
-- to enforce its own retention lifecycle.
DROP TRIGGER IF EXISTS transcript_event_memory_policy_details_no_delete;

-- A new session identity cannot reuse a parent's direct companion. Transition
-- provenance records the exact source event and both immutable identities so
-- readers can revalidate the origin without treating copied JSON as authority.
CREATE TABLE IF NOT EXISTS transcript_event_memory_policy_transitions (
  session_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  source_session_id TEXT NOT NULL,
  source_event_seq INTEGER NOT NULL,
  transition_kind TEXT NOT NULL CHECK (transition_kind IN (
    'parent-fork', 'fork', 'rewind', 'switch', 'checkpoint'
  )),
  source_session_identity_revision TEXT NOT NULL,
  target_session_identity_revision TEXT NOT NULL,
  subject_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, event_seq),
  FOREIGN KEY (session_id, event_seq)
    REFERENCES transcript_event_memory_policies(session_id, event_seq) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_event_memory_policy_transitions_source
  ON transcript_event_memory_policy_transitions(source_session_id, source_event_seq);

CREATE TRIGGER IF NOT EXISTS transcript_event_memory_policy_transitions_no_update
BEFORE UPDATE ON transcript_event_memory_policy_transitions
BEGIN
  SELECT RAISE(ABORT, 'transcript memory policy transitions are immutable');
END;

-- Compaction creates its own derived policy in Phase 2C. The table is owned
-- now so transitions can preserve the reference without inventing sidecars.
CREATE TABLE IF NOT EXISTS memory_compaction_policies (
  compaction_policy_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_policy_set_id TEXT NOT NULL,
  retention_state TEXT NOT NULL CHECK (retention_state IN ('retained', 'quarantined')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_policy_set_id) REFERENCES memory_policy_sets(policy_set_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER IF NOT EXISTS memory_compaction_policies_no_update
BEFORE UPDATE ON memory_compaction_policies
BEGIN
  SELECT RAISE(ABORT, 'memory compaction policies are immutable');
END;

CREATE TRIGGER IF NOT EXISTS memory_compaction_policies_no_delete
BEFORE DELETE ON memory_compaction_policies
BEGIN
  SELECT RAISE(ABORT, 'memory compaction policies cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS standing_intents (
  intent_key INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  trigger_keywords TEXT NOT NULL,
  trigger_embedding TEXT,
  channel_scope TEXT,
  sender_scope TEXT,
  creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'armed', 'fired', 'done', 'cancelled', 'expired')),
  expires_at INTEGER NOT NULL,
  max_fires INTEGER NOT NULL CHECK (max_fires > 0),
  fire_count INTEGER NOT NULL DEFAULT 0 CHECK (fire_count >= 0),
  cooldown_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (cooldown_seconds >= 0),
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL,
  source_session_id TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_standing_intents_lifecycle
  ON standing_intents(status, expires_at, last_fired_at);

CREATE INDEX IF NOT EXISTS idx_standing_intents_scope
  ON standing_intents(status, channel_scope, sender_scope);

CREATE VIRTUAL TABLE IF NOT EXISTS standing_intents_fts USING fts5(
  trigger_keywords,
  content = 'standing_intents',
  content_rowid = 'intent_key',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS standing_intents_fts_after_insert
AFTER INSERT ON standing_intents
BEGIN
  INSERT INTO standing_intents_fts(rowid, trigger_keywords)
  VALUES (new.intent_key, new.trigger_keywords);
END;

CREATE TRIGGER IF NOT EXISTS standing_intents_fts_after_delete
AFTER DELETE ON standing_intents
BEGIN
  INSERT INTO standing_intents_fts(standing_intents_fts, rowid, trigger_keywords)
  VALUES ('delete', old.intent_key, old.trigger_keywords);
END;

CREATE TRIGGER IF NOT EXISTS standing_intents_fts_after_update
AFTER UPDATE OF trigger_keywords ON standing_intents
BEGIN
  INSERT INTO standing_intents_fts(standing_intents_fts, rowid, trigger_keywords)
  VALUES ('delete', old.intent_key, old.trigger_keywords);
  INSERT INTO standing_intents_fts(rowid, trigger_keywords)
  VALUES (new.intent_key, new.trigger_keywords);
END;

CREATE TABLE IF NOT EXISTS session_transcript_index_state (
  session_id TEXT NOT NULL PRIMARY KEY,
  indexed_seq INTEGER NOT NULL,
  leaf_event_id TEXT,
  needs_rebuild INTEGER NOT NULL DEFAULT 0,
  active_event_count INTEGER NOT NULL DEFAULT 0,
  active_message_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES session_windows(session_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS session_transcript_active_events (
  session_id TEXT NOT NULL,
  active_position INTEGER NOT NULL CHECK (active_position >= 0),
  event_seq INTEGER NOT NULL,
  message_position INTEGER CHECK (message_position IS NULL OR message_position >= 0),
  PRIMARY KEY (session_id, active_position),
  FOREIGN KEY (session_id, event_seq) REFERENCES transcript_events(session_id, seq) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_transcript_active_event_seq
  ON session_transcript_active_events(session_id, event_seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_transcript_active_messages
  ON session_transcript_active_events(session_id, message_position)
  WHERE message_position IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(
  text,
  session_id UNINDEXED,
  message_id UNINDEXED,
  role UNINDEXED,
  timestamp UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT OR IGNORE INTO memory_index_state (id, revision) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_insert
AFTER INSERT ON memory_index_sources
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_update
AFTER UPDATE ON memory_index_sources
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_delete
AFTER DELETE ON memory_index_sources
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_insert
AFTER INSERT ON memory_index_chunks
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_update
AFTER UPDATE ON memory_index_chunks
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_delete
AFTER DELETE ON memory_index_chunks
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;

CREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at
  ON memory_embedding_cache(updated_at);

CREATE INDEX IF NOT EXISTS idx_memory_index_sources_source
  ON memory_index_sources(source);

CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source
  ON memory_index_chunks(path, source);

CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path
  ON memory_index_chunks(path);

CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
  ON memory_index_chunks(source);
