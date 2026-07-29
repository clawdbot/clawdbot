/**
 * @deprecated Broad public SDK barrel. Prefer focused plugin runtime subpaths
 * and avoid adding new imports here.
 */

export {
  clearPluginCommands,
  executePluginCommand,
  listRegisteredPluginAgentPromptGuidance,
  matchPluginCommand,
  registerPluginCommand,
} from "../plugins/commands.js";

export { createInteractiveConversationBindingHelpers } from "../plugins/interactive-binding-helpers.js";
export {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "../plugins/interactive.js";
export { startLazyPluginServiceModule } from "../plugins/lazy-service-module.js";
export type { LazyPluginServiceHandle } from "../plugins/lazy-service-module.js";
export type {
  OpenClawPluginApi,
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
  PluginInteractiveRegistration,
} from "../plugins/types.js";
export { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
export type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";

export { dispatchPluginInteractiveHandler } from "../plugins/interactive.js";
export { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
export { getPluginCommandSpecs } from "../plugins/command-specs.js";
export type { OpenClawPluginConfigSchema } from "../plugins/types.js";
