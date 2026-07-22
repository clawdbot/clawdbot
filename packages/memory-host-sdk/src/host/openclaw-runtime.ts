// Agent/runtime helpers.
import { readTranscriptStatsSync as readAccessorTranscriptStatsSync } from "../../../../src/config/sessions/session-accessor.js";

export { resolveCronStyleNow } from "../../../../src/agents/current-time.js";
export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../../../src/agents/agent-scope.js";
export { stripInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
export { DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../../../src/agents/agent-settings.js";
export {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "../../../../src/agents/tools/common.js";
export type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "../../../../src/agents/memory-search.js";

// Session and reply helpers.
export { isHeartbeatUserMessage } from "../../../../src/auto-reply/heartbeat-filter.js";
export { HEARTBEAT_PROMPT } from "../../../../src/auto-reply/heartbeat.js";
export { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
export {
  HEARTBEAT_TOKEN,
  SILENT_REPLY_TOKEN,
  isSilentReplyPayloadText,
} from "../../../../src/auto-reply/tokens.js";

// CLI/runtime/config helpers.
export { formatErrorMessage, withManager } from "../../../../src/cli/cli-utils.js";
export { resolveCommandSecretRefsViaGateway } from "../../../../src/cli/command-secret-gateway.js";
export { formatHelpExamples } from "../../../../src/cli/help-format.js";
export { parseDurationMs } from "../../../../src/cli/parse-duration.js";
export { withProgress, withProgressTotals } from "../../../../src/cli/progress.js";
export { parseNonNegativeByteSize } from "../../../../src/config/byte-size.js";
export {
  getRuntimeConfig,
  /** @deprecated Use getRuntimeConfig(), or pass the already loaded config through the call path. */
  loadConfig,
} from "../../../../src/config/config.js";
export type { OpenClawConfig } from "../../../../src/config/config.js";
export { resolveStateDir } from "../../../../src/config/paths.js";
export {
  isCompactionCheckpointTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "../../../../src/config/sessions/artifacts.js";
export { canonicalizeMainSessionAlias } from "../../../../src/config/sessions/main-session.js";
export {
  resolveSessionFilePath,
  resolveSessionTranscriptsDirForAgent,
} from "../../../../src/config/sessions/paths.js";
export {
  loadTranscriptEventsSync,
  listSessionEntries,
  readTranscriptStatsSync,
  resolveTranscriptSessionKeyBySessionId,
  resolveStorePath,
} from "../../../../src/plugin-sdk/session-store-runtime.js";
export { parseSqliteSessionFileMarker } from "../../../../src/plugin-sdk/session-store-runtime.js";
export type { SessionEntry } from "../../../../src/config/sessions/types.js";

/** Returns an opaque revision that changes for every canonical transcript mutation. */
export function readTranscriptContentRevisionSync(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): string {
  const stats = readAccessorTranscriptStatsSync(params);
  return [
    "sqlite",
    stats.maxSeq,
    stats.sizeBytes,
    stats.eventCount,
    stats.lastMutationAtMs ?? "",
    stats.lastObservedMutationAtMs ?? "",
  ].join(":");
}
export type { SessionSendPolicyConfig } from "../../../../src/config/types.base.js";
export type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdSearchMode,
} from "../../../../src/config/types.memory.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "../../../../src/config/types.secrets.js";
export type { SecretInput } from "../../../../src/config/types.secrets.js";
export type { MemorySearchConfig } from "../../../../src/config/types.tools.js";
export { isVerbose, setVerbose } from "../../../../src/globals.js";

// IO, network, and logging helpers.
export { isExecCompletionEvent } from "../../../../src/infra/heartbeat-events-filter.js";
export { root } from "../../../../src/infra/fs-safe.js";
export {
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
} from "../../../../src/infra/sqlite-wal.js";
export type {
  SqliteConnectionPragmaOptions,
  SqliteWalMaintenance,
  SqliteWalMaintenanceOptions,
} from "../../../../src/infra/sqlite-wal.js";
export { installProcessWarningFilter } from "../../../../src/infra/warning-filter.js";
export { redactSensitiveText } from "../../../../src/logging/redact.js";
export { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
export { detectMime } from "@openclaw/media-core/mime";

// Memory plugin helpers.
export {
  resolveCanonicalRootMemoryFile,
  shouldSkipRootMemoryAuxiliaryPath,
} from "../../../../src/memory/root-memory-files.js";
export {
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
  listRegisteredMemoryEmbeddingProviders,
} from "../../../../src/plugins/memory-embedding-provider-runtime.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCallOptions,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderRuntime,
} from "../../../../src/plugins/memory-embedding-providers.js";
export { emptyPluginConfigSchema } from "../../../../src/plugins/config-schema.js";
export {
  buildMemoryPromptSection as buildActiveMemoryPromptSection,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
} from "../../../../src/plugins/memory-state.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "../../../../src/plugins/memory-state.js";
export type { OpenClawPluginApi } from "../../../../src/plugins/types.js";

// Shared session/text utilities.
export { defaultRuntime } from "../../../../src/runtime.js";
export { parseAgentSessionKey } from "../../../../src/routing/session-key.js";
export { hasInterSessionUserProvenance } from "../../../../src/sessions/input-provenance.js";
export { isCronRunSessionKey } from "../../../../src/sessions/session-key-utils.js";
export { onSessionTranscriptUpdate } from "../../../../src/sessions/transcript-events.js";
export { formatDocsLink } from "../../../terminal-core/src/links.js";
export { colorize, isRich, theme } from "../../../terminal-core/src/theme.js";
export { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../../src/utils/cjk-chars.js";
export { runTasksWithConcurrency } from "../../../../src/utils/run-with-concurrency.js";
export { splitShellArgs } from "../../../../src/utils/shell-argv.js";
export {
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  truncateUtf16Safe,
} from "../../../../src/utils.js";
export {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../../../../src/plugin-sdk/windows-spawn.js";
export { resolveGlobalSingleton } from "../../../../src/shared/global-singleton.js";
