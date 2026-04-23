// Public binding helpers for both runtime plugin-owned bindings and
// config-driven channel bindings.

export {
  createConversationBindingRecord,
  getConversationBindingCapabilities,
  listSessionBindingRecords,
  resolveConversationBindingRecord,
  touchConversationBindingRecord,
  unbindConversationBindingRecord,
} from "../bindings/records.js";
export {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
  type ConfiguredBindingRouteResult,
  resolveRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "../channels/plugins/binding-routing.js";
export {
  primeConfiguredBindingRegistry,
  resolveConfiguredBinding,
  resolveConfiguredBindingRecord,
  resolveConfiguredBindingRecordBySessionKey,
  resolveConfiguredBindingRecordForConversation,
} from "../channels/plugins/binding-registry.js";
export {
  ensureConfiguredBindingTargetReady,
  ensureConfiguredBindingTargetSession,
  resetConfiguredBindingTargetInPlace,
} from "../channels/plugins/binding-targets.js";
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
  resolveThreadBindingEffectiveExpiresAt,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingLifecycle,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingsEnabled,
  resolveThreadBindingSpawnPolicy,
  type ThreadBindingSpawnKind,
  type ThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
export type {
  ConfiguredBindingConversation,
  ConfiguredBindingResolution,
  CompiledConfiguredBinding,
  StatefulBindingTargetDescriptor,
} from "../channels/plugins/binding-types.js";
export type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetSessionResult,
} from "../channels/plugins/stateful-target-drivers.js";
export {
  type BindingStatus,
  type BindingTargetKind,
  type ConversationRef,
  SessionBindingError,
  type SessionBindingAdapter,
  type SessionBindingAdapterCapabilities,
  type SessionBindingBindInput,
  type SessionBindingCapabilities,
  type SessionBindingPlacement,
  type SessionBindingRecord,
  type SessionBindingService,
  type SessionBindingUnbindInput,
  getSessionBindingService,
  isSessionBindingError,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
export { __testing } from "../infra/outbound/session-binding-service.js";
export * from "../pairing/pairing-challenge.js";
export { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
export * from "../pairing/pairing-messages.js";
export * from "../pairing/pairing-store.js";
export {
  buildPluginBindingApprovalCustomId,
  buildPluginBindingDeclinedText,
  buildPluginBindingErrorText,
  buildPluginBindingResolvedText,
  buildPluginBindingUnavailableText,
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  hasShownPluginBindingFallbackNotice,
  isPluginOwnedBindingMetadata,
  isPluginOwnedSessionBindingRecord,
  markPluginBindingFallbackNoticeShown,
  parsePluginBindingApprovalCustomId,
  requestPluginConversationBinding,
  resolvePluginConversationBindingApproval,
  toPluginConversationBinding,
} from "../plugins/conversation-binding.js";
export { resolvePinnedMainDmOwnerFromAllowlist } from "../security/dm-policy-shared.js";
