// Real workspace contract for memory engine foundation concerns.

export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "./host/openclaw-runtime-agent.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "./host/openclaw-runtime-agent.js";
export { parseDurationMs } from "./host/openclaw-runtime-config.js";
export { loadConfig } from "./host/openclaw-runtime-config.js";
export { resolveStateDir } from "./host/openclaw-runtime-config.js";
export { resolveSessionTranscriptsDirForAgent } from "./host/openclaw-runtime-config.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "./host/openclaw-runtime-config.js";
export { writeFileWithinRoot } from "./host/openclaw-runtime-io.js";
export { createSubsystemLogger } from "./host/openclaw-runtime-io.js";
export { detectMime } from "./host/openclaw-runtime-io.js";
export { resolveGlobalSingleton } from "./host/openclaw-runtime-io.js";
export { onSessionTranscriptUpdate } from "./host/openclaw-runtime-session.js";
export { splitShellArgs } from "./host/openclaw-runtime-io.js";
export { runTasksWithConcurrency } from "./host/openclaw-runtime-io.js";
export {
  shortenHomeInString,
  shortenHomePath,
  resolveUserPath,
  truncateUtf16Safe,
} from "./host/openclaw-runtime-io.js";
export type { OpenClawConfig } from "./host/openclaw-runtime-config.js";
export type { SessionSendPolicyConfig } from "./host/openclaw-runtime-config.js";
export type { SecretInput } from "./host/openclaw-runtime-config.js";
export type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdMcporterConfig,
  MemoryQmdSearchMode,
} from "./host/openclaw-runtime-config.js";
export type { MemorySearchConfig } from "./host/openclaw-runtime-config.js";
