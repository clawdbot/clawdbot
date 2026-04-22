export const CLAUDE_CLI_BACKEND_ID = "claude-cli";
export const CLAUDE_CLI_DEFAULT_MODEL_REF = `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-7`;
export const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS = [
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-4-6`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-6`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-opus-4-5`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-sonnet-4-5`,
  `${CLAUDE_CLI_BACKEND_ID}/claude-haiku-4-5`,
] as const;

export const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.7": "opus",
  "opus-4.6": "opus",
  "opus-4.5": "opus",
  "opus-4": "opus",
  "claude-opus-4-7": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-5": "opus",
  "claude-opus-4": "opus",
  sonnet: "sonnet",
  "sonnet-4.6": "sonnet",
  "sonnet-4.5": "sonnet",
  "sonnet-4.1": "sonnet",
  "sonnet-4.0": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-1": "sonnet",
  "claude-sonnet-4-0": "sonnet",
  haiku: "haiku",
  "haiku-3.5": "haiku",
  "claude-haiku-3-5": "haiku",
};

export const CLAUDE_CLI_SESSION_ID_FIELDS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
] as const;
