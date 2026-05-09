/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
export { buildChannelMessageReplyDispatchBase } from "./inbound-reply-dispatch.js";
/** @deprecated Compatibility reply-dispatch bridge. Use `sendDurableMessageBatch(...)` or `deliverInboundReplyWithMessageSendContext(...)`. */
export { dispatchChannelMessageReplyWithBase } from "./inbound-reply-dispatch.js";
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export { hasFinalChannelMessageReplyDispatch } from "./inbound-reply-dispatch.js";
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export { hasVisibleChannelMessageReplyDispatch } from "./inbound-reply-dispatch.js";
/** @deprecated Compatibility reply-dispatch bridge. Use `sendDurableMessageBatch(...)` or `deliverInboundReplyWithMessageSendContext(...)`. */
export { recordChannelMessageReplyDispatch } from "./inbound-reply-dispatch.js";
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export { resolveChannelMessageReplyDispatchCounts } from "./inbound-reply-dispatch.js";
/** @deprecated Compatibility assembly for legacy buffered reply dispatchers. */
export { createChannelTurnReplyPipeline } from "../channels/turn/kernel.js";
/** @deprecated Use `deliverInboundReplyWithMessageSendContext(...)`. */
export { deliverDurableInboundReplyPayload } from "../channels/turn/kernel.js";
export { deliverInboundReplyWithMessageSendContext } from "../channels/turn/kernel.js";
export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
  DurableInboundReplyDeliveryResult,
} from "../channels/turn/kernel.js";
export {
  sendDurableMessageBatch,
  withDurableMessageSendContext,
} from "../channels/message/runtime.js";
export type {
  DurableMessageBatchSendParams,
  DurableMessageBatchSendResult,
  DurableMessageSendContext,
  DurableMessageSendContextParams,
} from "../channels/message/runtime.js";
