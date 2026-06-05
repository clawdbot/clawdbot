// Memory Core plugin entrypoint registers its OpenClaw integration.
export { MemoryIndexManager } from "./manager.js";
export type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
export {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
  type MemorySearchManagerPurpose,
  type MemorySearchManagerResult,
} from "./search-manager.js";
