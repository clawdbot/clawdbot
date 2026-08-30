// Agent-facing runtime facade for memory host packages.
// Keep exports here limited to config/state helpers that memory plugins may reuse.
export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../../../src/agents/agent-scope.js";
export { resolveCronStyleNow } from "../../../../src/agents/current-time.js";
export { DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../../../src/agents/agent-settings.js";
export {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readToolStringParam as readStringParam,
} from "../../../../src/agents/tools/common.js";
export type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "../../../../src/agents/memory-search.js";
export { parseAgentSessionKey } from "../../../../src/routing/session-key.js";
