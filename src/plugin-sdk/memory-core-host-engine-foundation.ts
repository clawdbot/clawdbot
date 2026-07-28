/**
 * Public SDK foundation surface for memory host engine config, paths, and shared helpers.
 */

export { isPathInside } from "../../packages/memory-host-sdk/src/engine-foundation.js";
export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
} from "../agents/memory-search.js";
export type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";

export type { OpenClawConfig } from "../config/config.js";
export { resolveStateDir } from "../config/paths.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";

export type { MemorySearchConfig } from "../config/types.tools.js";
export { root } from "../infra/fs-safe.js";
export { createSubsystemLogger } from "../logging/subsystem.js";

export { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
export { resolveGlobalSingleton } from "../shared/global-singleton.js";

export { resolveUserPath, truncateUtf16Safe } from "../utils.js";
