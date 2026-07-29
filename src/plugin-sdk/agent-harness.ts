// Public agent harness surface for plugins that replace the low-level agent runtime.
// Keep model/vendor-specific protocol code in the plugin that registers the harness.

export {
  abortAgentHarnessRun,
  abortAndDrainAgentHarnessRun,
  createAgentToolResultMiddlewareRunner,
  disposeRegisteredAgentHarnesses,
  resolveActiveEmbeddedRunSessionId,
} from "./agent-harness-runtime.js";
export type {
  AgentHarness,
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  AnyAgentTool,
  EmbeddedRunAttemptParams,
  OpenClawAgentToolResult,
} from "./agent-harness-runtime.js";
export { createOpenClawCodingTools } from "../agents/agent-tools.js";
export { createCodexAppServerToolResultExtensionRunner } from "../agents/harness/codex-app-server-extensions.js";
export { resolveWebSearchToolPolicy } from "../agents/web-search-tool-policy.js";
