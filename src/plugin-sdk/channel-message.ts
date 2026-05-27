/**
 * @deprecated Use `openclaw/plugin-sdk/channel-outbound` for outbound/message
 * lifecycle helpers and `openclaw/plugin-sdk/channel-inbound` for inbound
 * reply dispatch helpers.
 */

import type { CreateChannelReplyPipelineParams } from "./channel-outbound.js";
import { createChannelMessageReplyPipeline } from "./channel-outbound.js";
import { deliverInboundReplyWithMessageSendContext } from "./channel-outbound.js";

export * from "./channel-outbound.js";
/** @deprecated Use `hasFinalInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { hasFinalChannelTurnDispatch } from "../channels/turn/dispatch-result.js";
/** @deprecated Use `hasVisibleInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { hasVisibleChannelTurnDispatch } from "../channels/turn/dispatch-result.js";
/** @deprecated Use `resolveInboundReplyDispatchCounts(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { resolveChannelTurnDispatchCounts } from "../channels/turn/dispatch-result.js";

/** @deprecated Use `createChannelMessageReplyPipeline(...)` from `openclaw/plugin-sdk/channel-outbound`. */
export function createChannelTurnReplyPipeline(params: CreateChannelReplyPipelineParams) {
  return createChannelMessageReplyPipeline(params);
}

/** @deprecated Use `buildInboundReplyDispatchBase(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { buildChannelMessageReplyDispatchBase } from "./inbound-reply-dispatch.js";
/** @deprecated Use `dispatchChannelInboundReply(...)` or `runPreparedInboundReply(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { dispatchChannelMessageReplyWithBase } from "./inbound-reply-dispatch.js";
/** @deprecated Use `recordChannelMessageReplyDispatch(...)` only from legacy compatibility paths. */
export { recordChannelMessageReplyDispatch } from "./inbound-reply-dispatch.js";
/** @deprecated Use `hasFinalInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { hasFinalChannelMessageReplyDispatch } from "./inbound-reply-dispatch.js";
/** @deprecated Use `hasVisibleInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { hasVisibleChannelMessageReplyDispatch } from "./inbound-reply-dispatch.js";
/** @deprecated Use `resolveInboundReplyDispatchCounts(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { resolveChannelMessageReplyDispatchCounts } from "./inbound-reply-dispatch.js";

/** @deprecated Use `deliverInboundReplyWithMessageSendContext(...)` from `openclaw/plugin-sdk/channel-outbound`. */
export const deliverDurableInboundReplyPayload = deliverInboundReplyWithMessageSendContext;
