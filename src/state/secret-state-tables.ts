/** Redaction policy surface: Git snapshots may omit these credential-bearing tables. */
export const STATE_SECRET_TABLE_NAMES = [
  "auth_profile_state",
  "auth_profile_stores",
  "device_auth_tokens",
  "device_bootstrap_tokens",
  "mcp_oauth_stores",
  "worker_environment_credentials",
] as const;

/** Redaction policy surface for credential-bearing per-agent database tables. */
export const AGENT_SECRET_TABLE_NAMES = ["auth_profile_state", "auth_profile_store"] as const;
