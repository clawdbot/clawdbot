// Recreate the exact v11 table contracts so migration and pinned-reader proofs
// can project a current database through the documented 12→11 downgrade.
const FOLDED_STATE_TABLES_V12_FIXTURE_SQL = `
CREATE TABLE IF NOT EXISTS skill_curator_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  last_attempt_at_ms INTEGER NOT NULL,
  last_success_at_ms INTEGER,
  last_error TEXT,
  last_result_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS onboarding_recommendations (
  config_key TEXT NOT NULL PRIMARY KEY,
  inventory_hash TEXT NOT NULL,
  matches_json TEXT NOT NULL,
  offered_at_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS voicewake_triggers (
  config_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (config_key, position)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_voicewake_triggers_trigger
  ON voicewake_triggers(config_key, trigger);

CREATE TABLE IF NOT EXISTS voicewake_routing_config (
  config_key TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL,
  default_target_mode TEXT NOT NULL,
  default_target_agent_id TEXT,
  default_target_session_key TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS voicewake_routing_routes (
  config_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  target_mode TEXT NOT NULL,
  target_agent_id TEXT,
  target_session_key TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (config_key, position),
  FOREIGN KEY (config_key) REFERENCES voicewake_routing_config(config_key) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_voicewake_routing_routes_trigger
  ON voicewake_routing_routes(config_key, trigger);

CREATE TABLE IF NOT EXISTS update_check_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  last_checked_at TEXT,
  last_notified_version TEXT,
  last_notified_tag TEXT,
  last_available_version TEXT,
  last_available_tag TEXT,
  auto_install_id TEXT,
  auto_first_seen_version TEXT,
  auto_first_seen_tag TEXT,
  auto_first_seen_at TEXT,
  auto_last_attempt_version TEXT,
  auto_last_attempt_at TEXT,
  auto_last_success_version TEXT,
  auto_last_success_at TEXT,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS clawhub_promotions_feed_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  etag TEXT,
  payload_json TEXT,
  feed_sequence INTEGER,
  last_checked_at_ms INTEGER,
  notified_slugs_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cron_store_epochs (
  store_key TEXT PRIMARY KEY,
  store_epoch INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS model_catalog_remote (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bundle_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  min_version TEXT,
  source_url TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS tui_last_sessions (
  scope_key TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_tui_last_sessions_session_key
  ON tui_last_sessions(session_key, updated_at DESC, scope_key);

CREATE TABLE IF NOT EXISTS sidebar_sections (
  section_id TEXT NOT NULL PRIMARY KEY,
  position INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS node_host_config (
  config_key TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  token TEXT,
  display_name TEXT,
  gateway_host TEXT,
  gateway_port INTEGER,
  gateway_tls INTEGER,
  gateway_tls_fingerprint TEXT,
  gateway_context_path TEXT,
  gateway_cloudflare_access_json TEXT,
  installed_apps_sharing INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS web_push_vapid_keys (
  key_id TEXT NOT NULL PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
`;

export const STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL = `${FOLDED_STATE_TABLES_V12_FIXTURE_SQL}
PRAGMA user_version = 11;
UPDATE schema_meta SET schema_version = 11 WHERE meta_key = 'primary';
`;
