// Compat surface: openclaw/plugin-sdk/conversation-binding-runtime
// Re-exports stable conversation binding helpers for channel extensions.

export {
  resolveConfiguredBindingRoute,
  ensureConfiguredBindingRouteReady,
} from "../channels/plugins/binding-routing.js";
export type { ConfiguredBindingRouteResult } from "../channels/plugins/binding-routing.js";
export { isPluginOwnedSessionBindingRecord } from "../plugins/conversation-binding.js";
export type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
