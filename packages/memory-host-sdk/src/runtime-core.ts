// Focused runtime contract for memory plugin config/state/helpers.

export type { AnyAgentTool } from "./host/openclaw-runtime-agent.js";
export { resolveCronStyleNow } from "./host/openclaw-runtime-agent.js";
export { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "./host/openclaw-runtime-agent.js";
export { resolveDefaultAgentId, resolveSessionAgentId } from "./host/openclaw-runtime-agent.js";
export { resolveMemorySearchConfig } from "./host/openclaw-runtime-agent.js";
export {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./host/openclaw-runtime-agent.js";
export { SILENT_REPLY_TOKEN } from "./host/openclaw-runtime-session.js";
export { parseNonNegativeByteSize } from "./host/openclaw-runtime-config.js";
export {
  getRuntimeConfig,
  /** @deprecated Use getRuntimeConfig(), or pass the already loaded config through the call path. */
  loadConfig,
} from "./host/openclaw-runtime-config.js";
export { resolveStateDir } from "./host/openclaw-runtime-config.js";
export { resolveSessionTranscriptsDirForAgent } from "./host/openclaw-runtime-config.js";
export { emptyPluginConfigSchema } from "./host/openclaw-runtime-memory.js";
export {
  buildActiveMemoryPromptSection,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
} from "./host/openclaw-runtime-memory.js";
export { parseAgentSessionKey } from "./host/openclaw-runtime-agent.js";
export type { OpenClawConfig } from "./host/openclaw-runtime-config.js";
export type { MemoryCitationsMode } from "./host/openclaw-runtime-config.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "./host/openclaw-runtime-memory.js";
export type { OpenClawPluginApi } from "./host/openclaw-runtime-memory.js";
