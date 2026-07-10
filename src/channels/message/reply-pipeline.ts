/**
 * Channel reply pipeline builder.
 *
 * Resolves source delivery mode, reply prefixing, typing callbacks, and payload transforms.
 */
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveResponsePrefixTemplate } from "../../auto-reply/reply/response-prefix-template.js";
import {
  resolveSourceReplyDeliveryMode,
  type SourceReplyDeliveryModeContext,
} from "../../auto-reply/reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getLoadedChannelPluginForRead } from "../plugins/registry-loaded-read.js";
import { normalizeAnyChannelId } from "../registry-normalize.js";
import {
  createReplyPrefixContext,
  createReplyPrefixOptions,
  type ReplyPrefixContextBundle,
  type ReplyPrefixOptions,
} from "../reply-prefix.js";
import {
  createTypingCallbacks,
  type CreateTypingCallbacksParams,
  type TypingCallbacks,
} from "../typing.js";

export type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
export type { ReplyPrefixContextBundle, ReplyPrefixOptions };
export type { CreateTypingCallbacksParams, TypingCallbacks };
export { createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks };
export type { SourceReplyDeliveryMode };

/** Resolves whether a channel reply should use source delivery, message tools, or direct sending. */
export function resolveChannelSourceReplyDeliveryMode(params: {
  /** Full config used to inspect source-reply delivery settings. */
  cfg: OpenClawConfig;
  /** Reply delivery context from the current channel turn. */
  ctx: SourceReplyDeliveryModeContext;
  /** Caller-requested delivery mode override. */
  requested?: SourceReplyDeliveryMode;
  /** Whether the message-send tool is available for this turn. */
  messageToolAvailable?: boolean;
}): SourceReplyDeliveryMode {
  return resolveSourceReplyDeliveryMode(params);
}

/** Reply pipeline options shared by core channel turns and plugin SDK callers. */
export type ChannelReplyPipeline = ReplyPrefixOptions & {
  /** Resolves a response prefix against the pipeline's live selected-model context. */
  resolveResponsePrefix?: () => string | undefined;
  /** Optional typing lifecycle callbacks for reply generation. */
  typingCallbacks?: TypingCallbacks;
  /** Optional payload transform applied before channel delivery. */
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};

/** Parameters for building a channel reply pipeline with prefix, typing, and payload transforms. */
export type CreateChannelReplyPipelineParams = {
  /** Full config used for reply prefix and channel plugin transform resolution. */
  cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
  /** Agent id used in reply prefix context. */
  agentId: string;
  /** Optional channel id for prefix context and plugin transform lookup. */
  channel?: string;
  /** Optional channel account id for prefix context and plugin transform lookup. */
  accountId?: string;
  /** Typing callback factory input. */
  typing?: CreateTypingCallbacksParams;
  /** Prebuilt typing callbacks that take precedence over `typing`. */
  typingCallbacks?: TypingCallbacks;
  /** Explicit payload transform; avoids channel plugin lookup when provided. */
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};

/** Builds the reply pipeline used by channel turns and plugin SDK reply helpers. */
export function createChannelReplyPipeline(
  params: CreateChannelReplyPipelineParams,
): ChannelReplyPipeline {
  const channelId = params.channel
    ? (normalizeAnyChannelId(params.channel) ?? params.channel)
    : undefined;
  let plugin: ReturnType<typeof getLoadedChannelPluginForRead> | undefined;
  let pluginTransformResolved = false;
  const resolvePluginTransform = () => {
    // Load the channel plugin lazily so reply-pipeline construction stays cheap for hot turn paths.
    // The resolved transform is process-stable for this pipeline; plugin registry
    // changes require a new pipeline rather than repeated hot-path lookups.
    if (pluginTransformResolved) {
      return plugin?.messaging?.transformReplyPayload;
    }
    pluginTransformResolved = true;
    plugin = channelId ? getLoadedChannelPluginForRead(channelId) : undefined;
    return plugin?.messaging?.transformReplyPayload;
  };
  const transformReplyPayload = params.transformReplyPayload
    ? params.transformReplyPayload
    : channelId
      ? (payload: ReplyPayload) =>
          resolvePluginTransform()?.({
            payload,
            cfg: params.cfg,
            accountId: params.accountId,
          }) ?? payload
      : undefined;
  const prefixOptions = createReplyPrefixOptions({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
  });
  return {
    ...prefixOptions,
    resolveResponsePrefix: () =>
      resolveResponsePrefixTemplate(
        prefixOptions.responsePrefix,
        prefixOptions.responsePrefixContextProvider(),
      ),
    ...(transformReplyPayload ? { transformReplyPayload } : {}),
    ...(params.typingCallbacks
      ? { typingCallbacks: params.typingCallbacks }
      : params.typing
        ? { typingCallbacks: createTypingCallbacks(params.typing) }
        : {}),
  };
}
