// Memory Core plugin entrypoint registers its OpenClaw integration.
export { MemoryIndexManager } from "./manager.js";
export {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
  refreshMemorySearchManager,
} from "./search-manager.js";
