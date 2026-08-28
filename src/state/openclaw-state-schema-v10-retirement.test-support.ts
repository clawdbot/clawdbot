// Exact schema of the six dead tables retired by state schema 10, matching the
// documented 10→9 downgrade recipe in docs/reference/database-schemas.md.
// Tests use it to rebuild v9-shaped databases: the v10 retirement regression
// seeds a pre-migration file, and the pinned pre-C04 audit reader projects a
// current database back to the v9 era it was built against.
const RETIRED_STATE_TABLES_V10_FIXTURE_SQL = `
CREATE TABLE IF NOT EXISTS agent_model_catalogs (
  catalog_key TEXT NOT NULL PRIMARY KEY,
  agent_dir TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_agent_model_catalogs_agent_dir
  ON agent_model_catalogs(agent_dir, updated_at DESC);

CREATE TABLE IF NOT EXISTS android_notification_recent_packages (
  package_name TEXT NOT NULL PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_android_notification_recent_packages_order
  ON android_notification_recent_packages(sort_order, package_name);

CREATE TABLE IF NOT EXISTS command_log_entries (
  id TEXT NOT NULL PRIMARY KEY,
  timestamp_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  session_key TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  source TEXT NOT NULL,
  entry_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_command_log_entries_timestamp
  ON command_log_entries(timestamp_ms DESC, id);
CREATE INDEX IF NOT EXISTS idx_command_log_entries_session
  ON command_log_entries(session_key, timestamp_ms DESC, id);

CREATE TABLE IF NOT EXISTS diagnostic_stability_bundles (
  bundle_key TEXT NOT NULL PRIMARY KEY,
  reason TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_diagnostic_stability_bundles_created
  ON diagnostic_stability_bundles(created_at DESC, bundle_key);

CREATE TABLE IF NOT EXISTS media_blobs (
  subdir TEXT NOT NULL,
  id TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  blob BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subdir, id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_media_blobs_created
  ON media_blobs(created_at);

CREATE TABLE IF NOT EXISTS model_capability_cache (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input_text INTEGER NOT NULL,
  input_image INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  supports_tools INTEGER,
  context_window INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  cost_input REAL NOT NULL,
  cost_output REAL NOT NULL,
  cost_cache_read REAL NOT NULL,
  cost_cache_write REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_model_capability_cache_provider_updated
  ON model_capability_cache(provider_id, updated_at_ms DESC, model_id);
`;

// The documented downgrade rewinds both version markers in the same batch.
export const STATE_SCHEMA_10_TO_9_DOWNGRADE_SQL = `${RETIRED_STATE_TABLES_V10_FIXTURE_SQL}
PRAGMA user_version = 9;
UPDATE schema_meta SET schema_version = 9 WHERE meta_key = 'primary';
`;
