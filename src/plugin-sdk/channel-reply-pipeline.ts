/**
 * @deprecated Legacy reply-pipeline subpath. New channel message code should
 * use `openclaw/plugin-sdk/channel-message`.
 */

export {
  createChannelReplyPipeline,
  createReplyPrefixContext,
  createReplyPrefixOptions,
  createTypingCallbacks,
  resolveChannelSourceReplyDeliveryMode,
} from "./channel-reply-core.js";
export type {
  ChannelReplyPipeline,
  CreateTypingCallbacksParams,
  ReplyPrefixContext,
  ReplyPrefixContextBundle,
  ReplyPrefixOptions,
  SourceReplyDeliveryMode,
  TypingCallbacks,
} from "./channel-reply-core.js";
