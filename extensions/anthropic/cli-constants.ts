export const CLAUDE_CLI_BACKEND_ID = "claude-cli";
export const CLAUDE_CLI_DEFAULT_MODEL_REF = `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-7`;
export const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS = [
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-4-6`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-6`,
] as const;

export const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.7": "opus",
  "opus-4.6": "opus",
  "claude-opus-4-7": "opus",
  "claude-opus-4-6": "opus",
  sonnet: "sonnet",
  "sonnet-4.6": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  haiku: "haiku",
};

export const CLAUDE_CLI_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
] as const;
