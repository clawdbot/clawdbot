// Real workspace contract for memory engine foundation concerns.

export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "../agents/memory-search.js";
export { parseDurationMs } from "../cli/parse-duration.js";
export { loadConfig } from "../config/config.js";
export { resolveStateDir } from "../config/paths.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "../config/types.secrets.js";
export { writeFileWithinRoot } from "../infra/fs-safe.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { detectMime } from "../media/mime.js";
export { resolveGlobalSingleton } from "../shared/global-singleton.js";
export { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
export { splitShellArgs } from "../utils/shell-argv.js";
export { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
export {
  shortenHomeInString,
  shortenHomePath,
  resolveUserPath,
  truncateUtf16Safe,
} from "../utils.js";
export type { OpenClawConfig } from "../config/config.js";
export type { SessionSendPolicyConfig } from "../config/types.base.js";
export type { SecretInput } from "../config/types.secrets.js";
export type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdMcporterConfig,
  MemoryQmdSearchMode,
} from "../config/types.memory.js";
export type { MemorySearchConfig } from "../config/types.tools.js";
