/**
 * Lazy import boundary for effective-tool inventory helpers used by gateway RPCs.
 */
export {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
export {
  resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContext,
} from "../../agents/tools-effective-inventory.js";
export {
  buildBundleMcpToolsFromCatalog,
  peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary,
} from "../../agents/agent-bundle-mcp-tools.js";
export { applyFinalEffectiveToolPolicy } from "../../agents/embedded-agent-runner/effective-tool-policy.js";
export { resolveReplyToMode } from "../../auto-reply/reply/reply-threading.js";
export { resolveRuntimeConfigCacheKey } from "../../config/config.js";
export {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
} from "../../plugins/runtime.js";
export { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
export { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
