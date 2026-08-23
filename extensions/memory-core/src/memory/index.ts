// Memory Core plugin entrypoint registers its OpenClaw integration.
export { MemoryIndexManager } from "./manager.js";
export {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./search-manager.js";
