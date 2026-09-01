// Shared prompt snapshot fixture directories.

/** Codex runtime happy-path prompt snapshot fixture directory. */
export const CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR =
  "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path";
export const CODEX_PROMPT_SNAPSHOT_FILES = {
  "telegram-direct": "telegram-direct-codex-message-tool.md",
  "discord-group": "discord-group-codex-message-tool.md",
  "heartbeat-turn": "telegram-heartbeat-codex-tool.md",
} as const;
export type CodexPromptSnapshotScenario = keyof typeof CODEX_PROMPT_SNAPSHOT_FILES;
export const CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO: CodexPromptSnapshotScenario = "telegram-direct";
/** Codex model prompt fixture directory. */
export const CODEX_MODEL_PROMPT_FIXTURE_DIR =
  "test/fixtures/agents/prompt-snapshots/codex-model-catalog";
