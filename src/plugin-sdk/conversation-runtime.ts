/**
 * @deprecated Broad public SDK barrel. Prefer focused conversation/thread
 * binding subpaths and avoid adding new imports here.
 */

export {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "../channels/plugins/binding-routing.js";
export type {
  ConfiguredBindingRouteResult,
  RuntimeConversationBindingRouteResult,
} from "../channels/plugins/binding-routing.js";

export { resolveConversationLabel } from "../channels/conversation-label.js";
export { recordInboundSession } from "../channels/session.js";
export { recordInboundSessionMetaSafe } from "../channels/session-meta.js";
export { resolveThreadBindingConversationIdFromBindingId } from "../channels/thread-binding-id.js";
export {
  createScopedAccountReplyToModeResolver,
  createStaticReplyToModeResolver,
  createTopLevelChannelReplyToModeResolver,
} from "../channels/plugins/threading-helpers.js";
export {
  formatThreadBindingDurationLabel,
  resolveThreadBindingFarewellText,
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
export {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingEffectiveExpiresAt,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingsEnabled,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
export { resolveThreadBindingLifecycle } from "../shared/thread-binding-lifecycle.js";

export {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
export type {
  BindingTargetKind,
  SessionBindingAdapter,
  SessionBindingBindInput,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export { testing } from "../infra/outbound/session-binding-service.js";

export { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
export { buildPairingReply } from "../pairing/pairing-messages.js";
export {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
export {
  buildPluginBindingApprovalCustomId,
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "../plugins/conversation-binding.js";
export { resolvePinnedMainDmOwnerFromAllowlist } from "./channel-access-compat.js";
