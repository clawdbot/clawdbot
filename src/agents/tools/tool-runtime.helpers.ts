/**
 * Shared runtime helper barrel for tool implementations.
 *
 * Tools import from this module when they need model auth, fallback, discovery,
 * sandbox media paths, or workspace helpers without depending on broad agent barrels.
 */
export { getApiKeyForModel, requireApiKey } from "../model-auth.js";
export { runWithImageModelFallback } from "../model-fallback.js";
export {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type SandboxedBridgeMediaPathConfig,
} from "../sandbox-media-paths.js";
export type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
export type { ToolFsPolicy } from "../tool-fs-policy.js";
export { normalizeWorkspaceDir } from "../workspace-dir.js";
export type { AnyAgentTool } from "./common.js";
