export { createRuntimeOutboundDelegates } from "../channels/plugins/runtime-forwarders.js";
export { resolveOutboundSendDep, type OutboundSendDeps } from "../infra/outbound/send-deps.js";
export { resolveAgentOutboundIdentity, type OutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundDeliveryFormattingOptions } from "../infra/outbound/formatting.js";
export { createReplyToFanout, type ReplyToResolution } from "../infra/outbound/reply-policy.js";
/**
 * @deprecated Direct outbound delivery is compatibility/runtime substrate. New
 * channel and plugin send paths should use
 * `openclaw/plugin-sdk/channel-message-runtime` helpers:
 * `sendDurableMessageBatch`, `withDurableMessageSendContext`, or
 * `deliverInboundReplyWithMessageSendContext`.
 */
export { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
/**
 * @deprecated Direct outbound delivery params are compatibility/runtime
 * substrate. New channel and plugin send paths should use
 * `openclaw/plugin-sdk/channel-message-runtime` helpers.
 */
export type { DeliverOutboundPayloadsParams } from "../infra/outbound/deliver.js";
export { type OutboundDeliveryResult } from "../infra/outbound/deliver.js";
export { sanitizeForPlainText } from "../infra/outbound/sanitize-text.js";
export {
  buildOutboundSessionContext,
  type OutboundSessionContext,
} from "../infra/outbound/session-context.js";
export {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "../infra/outbound/payloads.js";
