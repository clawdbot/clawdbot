/**
 * Runtime dependency barrel for subagent spawning. Keeping these imports in a
 * single module lets spawn tests replace runtime seams without loading the
 * entire gateway/channel stack.
 */
export {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from "../config/agent-limits.js";
export { getRuntimeConfig } from "../config/config.js";
export { loadSessionEntry, upsertSessionEntry } from "../config/sessions/session-accessor.js";
export { forkSessionEntryFromParent } from "../auto-reply/reply/session-fork.js";
export { ensureContextEnginesInitialized } from "../context-engine/init.js";
export { resolveContextEngine } from "../context-engine/registry.js";
export { callGateway } from "../gateway/call.js";
export {
  dispatchGatewayMethodInProcess,
  hasInProcessGatewayContext,
} from "../gateway/server-plugins.js";
export {
  ADMIN_SCOPE,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "../gateway/method-scopes.js";
export { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
export { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
export { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
export { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
export {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
export { resolveAgentConfig } from "./agent-scope.js";
export { AGENT_LANE_SUBAGENT } from "./lanes.js";
export { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";
