/**
 * @deprecated Use `openclaw/plugin-sdk/channel-inbound` for inbound runners and
 * dispatch predicates. Use `openclaw/plugin-sdk/channel-outbound` for message
 * delivery helpers.
 */

export {
  runPreparedInboundReply,
  runPreparedInboundReplyTurn,
  runChannelInboundEvent,
  runInboundReplyTurn,
  dispatchChannelInboundReply,
  hasFinalInboundReplyDispatch,
  hasVisibleInboundReplyDispatch,
  deliverInboundReplyWithMessageSendContext,
  recordDroppedChannelTurnHistory,
  recordDroppedChannelInboundHistory,
  resolveInboundReplyDispatchCounts,
  dispatchReplyFromConfigWithSettledDispatcher,
  buildInboundReplyDispatchBase,
  dispatchInboundReplyWithBase,
  recordInboundSessionAndDispatchReply,
  recordChannelBotPairLoopAndCheckSuppression,
} from "../channels/message/inbound-reply-dispatch.js";
export type {
  ChannelTurnDroppedHistoryOptions,
  ChannelInboundDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  InboundReplyRecordOptions,
  DurableInboundReplyDeliveryParams,
  ChannelBotLoopProtectionFacts,
  ChannelInboundEventRunnerParams,
  PreparedInboundReply,
  AssembledInboundReply,
  InboundReplyDispatchResult,
} from "../channels/message/inbound-reply-dispatch.js";
