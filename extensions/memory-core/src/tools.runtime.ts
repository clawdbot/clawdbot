// Memory Core plugin module implements tools behavior.
export {
  readAgentMemoryFile,
  resolveMemoryBackendConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
export {
  closeMemorySearchManager,
  getMemorySearchManager,
  refreshMemorySearchManager,
} from "./memory/index.js";
