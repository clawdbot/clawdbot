// Narrow thread-binding lifecycle helpers for extensions that need binding
// expiry and session-binding record types without loading the full
// conversation-runtime surface.

export { resolveThreadBindingConversationIdFromBindingId } from "../channels/thread-binding-id.js";
export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingLifecycle,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../channels/thread-bindings-policy.js";
export type {
  BindingTargetKind,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export {
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
  type AccountScopedConversationBindingManager,
  type AccountScopedConversationBindingRecord,
} from "../infra/outbound/account-scoped-conversation-bindings.js";
export {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
