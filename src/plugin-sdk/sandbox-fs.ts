/** Public filesystem contract for sandbox backend discovery. */
export type {
  SandboxFsBridge,
  SandboxFsDirectoryEntry,
  SandboxFsStat,
  SandboxResolvedPath,
} from "../agents/sandbox/fs-bridge.types.js";
export type {
  SandboxDirectoryListingSource,
  SandboxDirectoryRoot,
} from "../agents/sandbox/fs-bridge.discovery.js";
export {
  createDescriptorAnchoredSandboxDirectoryListingSource,
  listSandboxDirectoryWithinBounds,
  SANDBOX_FS_DIRECTORY_MAX_BYTES,
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
} from "../agents/sandbox/fs-bridge.discovery.js";
