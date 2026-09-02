/**
 * Shared identifiers for representing Codex native subagents as OpenClaw task
 * runtime rows.
 */
/** Task runtime namespace for Codex native subagent task rows. */
export const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
/** Task kind used to distinguish native Codex subagents from other subagent runtimes. */
export const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
/** Run id prefix for task rows keyed by Codex child thread ids. */
export const CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX = "codex-thread:";
