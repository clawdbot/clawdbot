// Focused runtime contract for memory file/backend access.

export { listMemoryFiles, normalizeExtraMemoryPaths } from "./host/internal.js";
export { readAgentMemoryFile } from "./host/read-file.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export type {
  MemoryEntryProvenance,
  MemoryOriginClass,
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
  MemorySessionKind,
} from "./host/types.js";
