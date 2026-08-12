/** Redaction policy surface: Git snapshots may omit these credential-bearing tables. */
export const STATE_SECRET_TABLE_NAMES = [
  "auth_profile_state",
  "auth_profile_stores",
  "apns_registrations",
  "channel_ingress_events",
  "clawhub_promotion_claims",
  "device_auth_tokens",
  "device_bootstrap_tokens",
  "device_identities",
  "device_pairing_paired",
  "gateway_origin_device_tokens",
  "mcp_oauth_stores",
  "native_hook_relay_bridges",
  "node_host_config",
  "secret_store_entries",
  "web_push_subscriptions",
  "web_push_vapid_keys",
  "worker_environment_credentials",
] as const;

/** Redaction policy surface for credential-bearing per-agent database tables. */
export const AGENT_SECRET_TABLE_NAMES = [
  "auth_profile_state",
  "auth_profile_store",
  "session_suggestions",
] as const;
