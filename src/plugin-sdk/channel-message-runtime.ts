/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
export { buildChannelMessageReplyDispatchBase } from "./channel-message.js";
/** @deprecated Compatibility reply-dispatch bridge. Use `sendDurableMessageBatch(...)` or `deliverInboundReplyWithMessageSendContext(...)`. */
export { dispatchChannelMessageReplyWithBase } from "./channel-message.js";
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export { hasFinalChannelMessageReplyDispatch } from "./channel-message.js";
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export { hasVisibleChannelMessageReplyDispatch } from "./channel-message.js";
/** @deprecated Compatibility reply-dispatch bridge. Use `sendDurableMessageBatch(...)` or `deliverInboundReplyWithMessageSendContext(...)`. */
export { recordChannelMessageReplyDispatch } from "./channel-message.js";
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export { resolveChannelMessageReplyDispatchCounts } from "./channel-message.js";
/** @deprecated Compatibility assembly for legacy buffered reply dispatchers. */
export { createChannelTurnReplyPipeline } from "./channel-message.js";
/** @deprecated Use `deliverInboundReplyWithMessageSendContext(...)`. */
export { deliverDurableInboundReplyPayload } from "./channel-message.js";
export { deliverInboundReplyWithMessageSendContext } from "./channel-message.js";
export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
  DurableInboundReplyDeliveryResult,
} from "./channel-message.js";
export { sendDurableMessageBatch, withDurableMessageSendContext } from "./channel-message.js";
export type {
  DurableMessageBatchSendParams,
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "./channel-message.js";
