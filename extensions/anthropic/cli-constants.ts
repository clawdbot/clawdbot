/**
 * Shared Claude CLI constants. These identify the synthetic backend, default
 * model refs, aliases, and session-id fields used across runtime and setup.
 */
/** Synthetic provider/backend id for Claude Code CLI-backed Anthropic models. */
export const CLAUDE_CLI_BACKEND_ID = "claude-cli";
/** Retired copied profile owned by the native Claude provider, never generic auth. */
export const CLAUDE_CLI_RETIRED_PROFILE_ID = `anthropic:${CLAUDE_CLI_BACKEND_ID}`;
/** Non-secret marker telling OpenClaw that the installed Claude CLI owns auth. */
export const CLAUDE_CLI_NATIVE_AUTH_MARKER = ["openclaw", "claude-cli-native-auth"].join(":");

/** Explicit thinking opt-out for Claude CLI routes unsupported by Claude Code. */
export const CLAUDE_CLI_OFF_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} as const;

// Claude owns native login selection; inherited routing, credentials, plugins,
// and telemetry must not redirect managed execution or authentication probes.
export const CLAUDE_CLI_CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
] as const;

/** Default Claude CLI model ref for agent defaults and live tests. */
export const CLAUDE_CLI_DEFAULT_MODEL_REF = `${CLAUDE_CLI_BACKEND_ID}/claude-opus-5`;
/** Provider-relative model id for Anthropic runtime-policy resolution. */
const CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_ID = CLAUDE_CLI_DEFAULT_MODEL_REF.slice(
  CLAUDE_CLI_BACKEND_ID.length + 1,
);
/** Canonical model ref routed to the Claude CLI backend by Anthropic setup. */
export const CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF = `anthropic/${CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_ID}`;
/** Default Claude CLI models allowed when setup seeds the model allowlist. */
export const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS = [
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-5`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-fable-5`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-8`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-7`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-4-6`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-6`,
] as const;

/**
 * Claude CLI model ids probed when detecting an existing CLI route, canonical
 * default first. Route detection must not depend on which model is currently
 * the default: existing configs route older Claude models, so probing only the
 * default would stop advertising session creation after a default bump.
 */
export const CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS = CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS.map((ref) =>
  ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1),
);

/** User-facing Claude CLI model aliases normalized before execution. */
export const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-5": "claude-opus-5",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-5": "claude-opus-5",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  sonnet: "sonnet",
  "sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5": "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  fable: "fable",
  "fable-5": "claude-fable-5",
  "claude-fable-5": "claude-fable-5",
  haiku: "haiku",
};

/** JSONL fields that may contain Claude CLI session ids. */
export const CLAUDE_CLI_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
] as const;
