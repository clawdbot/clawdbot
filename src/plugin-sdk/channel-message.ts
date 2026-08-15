/**
 * @deprecated Use `openclaw/plugin-sdk/channel-outbound` for outbound/message
 * lifecycle helpers and `openclaw/plugin-sdk/channel-inbound` for inbound
 * reply dispatch helpers.
 */

export * from "./channel-outbound.js";
/** @deprecated Use `hasFinalInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { hasFinalChannelTurnDispatch } from "../channels/turn/dispatch-result.js";
/** @deprecated Use `hasVisibleInboundReplyDispatch(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { hasVisibleChannelTurnDispatch } from "../channels/turn/dispatch-result.js";
/** @deprecated Use `resolveInboundReplyDispatchCounts(...)` from `openclaw/plugin-sdk/channel-inbound`. */
export { resolveChannelTurnDispatchCounts } from "../channels/turn/dispatch-result.js";
