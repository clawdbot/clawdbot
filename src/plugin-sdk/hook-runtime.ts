/**
 * @deprecated Broad public SDK barrel. Prefer focused hook/plugin runtime
 * subpaths and avoid adding new imports here.
 */

export { fireAndForgetBoundedHook } from "../hooks/fire-and-forget.js";
export {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
export {
  deriveInboundMessageHookContext,
  toInternalMessageReceivedContext,
  toInternalMessageSentContext,
  toPluginMessageReceivedEvent,
} from "../hooks/message-hook-mappers.js";
export {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";

export {
  buildCanonicalSentMessageHookContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../hooks/message-hook-mappers.js";
export { fireAndForgetHook } from "../hooks/fire-and-forget.js";
