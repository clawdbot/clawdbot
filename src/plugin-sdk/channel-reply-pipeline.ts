import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import {
  createReplyPrefixContext,
  createReplyPrefixOptions,
  type ReplyPrefixContextBundle,
  type ReplyPrefixOptions,
} from "../channels/reply-prefix.js";
import {
  createTypingCallbacks,
  type CreateTypingCallbacksParams,
  type TypingCallbacks,
} from "../channels/typing.js";

export type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
export type { ReplyPrefixContextBundle, ReplyPrefixOptions };
export type { CreateTypingCallbacksParams, TypingCallbacks };
export { createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks };

export type ChannelReplyPipeline = ReplyPrefixOptions & {
  typingCallbacks?: TypingCallbacks;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};

export function createChannelReplyPipeline(params: {
  cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
  agentId: string;
  channel?: string;
  accountId?: string;
  typing?: CreateTypingCallbacksParams;
  typingCallbacks?: TypingCallbacks;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
}): ChannelReplyPipeline {
  const channelId = params.channel
    ? (normalizeChannelId(params.channel) ?? params.channel)
    : undefined;
  const plugin = params.transformReplyPayload
    ? undefined
    : channelId
      ? getChannelPlugin(channelId)
      : undefined;
  const transformReplyPayload =
    params.transformReplyPayload ??
    (plugin?.messaging?.transformReplyPayload
      ? (payload: ReplyPayload) =>
          plugin.messaging?.transformReplyPayload?.({
            payload,
            cfg: params.cfg,
            accountId: params.accountId,
          }) ?? payload
      : undefined);
  return {
    ...createReplyPrefixOptions({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: params.channel,
      accountId: params.accountId,
    }),
    ...(transformReplyPayload ? { transformReplyPayload } : {}),
    ...(params.typingCallbacks
      ? { typingCallbacks: params.typingCallbacks }
      : params.typing
        ? { typingCallbacks: createTypingCallbacks(params.typing) }
        : {}),
  };
}
