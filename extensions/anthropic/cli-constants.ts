/**
 * Shared Claude CLI constants. These identify the synthetic backend, default
 * model refs, aliases, and session-id fields used across runtime and setup.
 */
/** Synthetic provider/backend id for Claude Code CLI-backed Anthropic models. */
export const CLAUDE_CLI_BACKEND_ID = "claude-cli";
/** Default Claude CLI model ref for agent defaults and live tests. */
export const CLAUDE_CLI_DEFAULT_MODEL_REF = `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-8`;
/** Provider-relative model id for Anthropic runtime-policy resolution. */
export const CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_ID = CLAUDE_CLI_DEFAULT_MODEL_REF.slice(
  CLAUDE_CLI_BACKEND_ID.length + 1,
);
/** Canonical model ref routed to the Claude CLI backend by Anthropic setup. */
export const CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF = `anthropic/${CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_ID}`;
/** Default Claude CLI models allowed when setup seeds the model allowlist. */
export const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS = [
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-5`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-7`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-4-6`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-6`,
] as const;

/** User-facing Claude CLI model aliases normalized before execution. */
export const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  sonnet: "sonnet",
  "sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5": "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  haiku: "haiku",
};

/** JSONL fields that may contain Claude CLI session ids. */
export const CLAUDE_CLI_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
] as const;
