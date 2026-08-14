type BareNullableSqliteDatatype = "ANY" | "BLOB" | "INT" | "INTEGER" | "REAL" | "TEXT";
type LazyAdditiveStateColumnDefinition = {
  columnName: string;
  dataType: BareNullableSqliteDatatype;
  tableName: string;
};

// Added after v6 shipped. Every definition stays bare and nullable so older v6
// writers can omit it safely when a newer build has already ensured the column.
export const CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS = [
  { columnName: "bootstrap_content_digest", dataType: "TEXT", tableName: "claw_installs" },
  { columnName: "bootstrap_source_path", dataType: "TEXT", tableName: "claw_installs" },
  { columnName: "desktop_json", dataType: "TEXT", tableName: "worker_environments" },
  { columnName: "bootstrap_install_kind", dataType: "TEXT", tableName: "worker_environments" },
  { columnName: "extension_adapter_identity", dataType: "TEXT", tableName: "claw_package_refs" },
  { columnName: "extension_detected_format", dataType: "TEXT", tableName: "claw_package_refs" },
  { columnName: "extension_format", dataType: "TEXT", tableName: "claw_package_refs" },
  { columnName: "extension_id", dataType: "TEXT", tableName: "claw_package_refs" },
  { columnName: "extension_mapped_json", dataType: "TEXT", tableName: "claw_package_refs" },
  { columnName: "extension_unavailable_json", dataType: "TEXT", tableName: "claw_package_refs" },
  { columnName: "shared_host", dataType: "INTEGER", tableName: "worker_environments" },
  { columnName: "terminal_reason", dataType: "TEXT", tableName: "worker_session_placements" },
  { columnName: "terminal_at_ms", dataType: "INTEGER", tableName: "worker_session_placements" },
  { columnName: "run_end_cleanup_json", dataType: "TEXT", tableName: "worktrees" },
  { columnName: "setup_id", dataType: "TEXT", tableName: "device_bootstrap_tokens" },
  { columnName: "workspace_dir", dataType: "TEXT", tableName: "installed_plugin_index" },
  { columnName: "allowed_hosts", dataType: "TEXT", tableName: "secret_store_entries" },
] as const satisfies readonly LazyAdditiveStateColumnDefinition[];

// Most same-version columns repair during a writable shared-state open. Setup
// correlation is different: unrelated opens and generic bootstrap credentials
// must leave older databases untouched until setup pairing first uses it.
export const CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS =
  CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS.filter(
    ({ columnName, tableName }) =>
      tableName !== "device_bootstrap_tokens" || columnName !== "setup_id",
  );

export const CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS =
  CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS.filter(
    ({ columnName, tableName }) =>
      tableName === "device_bootstrap_tokens" && columnName === "setup_id",
  );
