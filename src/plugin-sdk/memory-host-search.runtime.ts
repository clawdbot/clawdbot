/**
 * Runtime SDK subpath for active memory search manager operations.
 */
export {
  closeActiveMemorySearchManagerCore as closeActiveMemorySearchManager,
  closeActiveMemorySearchManagersCore as closeActiveMemorySearchManagers,
  getActiveMemorySearchManagerCore as getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";
