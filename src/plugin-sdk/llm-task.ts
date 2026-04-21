// Narrow plugin-sdk surface for the bundled llm-task plugin.
// Keep this list additive and scoped to the bundled LLM task surface.

export { definePluginEntry } from "./plugin-entry.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export {
  formatThinkingLevels,
  formatXHighModelHint,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  resolveSupportedThinkingLevel,
  supportsXHighThinking,
} from "../auto-reply/thinking.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";
