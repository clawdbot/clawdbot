// Internal source-reply policy is shared by message execution and CLI delivery capture.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseSessionDeliveryRoute } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { isConfiguredChannel, listConfiguredMessageChannels } from "./channel-selection.js";

type InternalSourceReplySinkInput = {
  cfg: OpenClawConfig;
  action: string;
  toolContext?: ChannelThreadingToolContext;
  sessionKey?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};

function hasExternalSessionDeliveryRoute(sessionKey: string | undefined): boolean {
  const route = parseSessionDeliveryRoute(sessionKey);
  if (!route) {
    return false;
  }
  const channel = normalizeMessageChannel(route.channel);
  return Boolean(channel && channel !== INTERNAL_MESSAGE_CHANNEL);
}

function hasExplicitRouteParam(params: Record<string, unknown>): boolean {
  for (const key of ["channel", "target", "to", "channelId"]) {
    if (normalizeOptionalString(params[key])) {
      return true;
    }
  }
  return (
    Array.isArray(params.targets) && params.targets.some((value) => normalizeOptionalString(value))
  );
}

function hasCurrentSourceReplyContext(input: InternalSourceReplySinkInput): boolean {
  const provider = normalizeOptionalLowercaseString(input.toolContext?.currentChannelProvider);
  if (!provider) {
    return false;
  }
  if (provider === INTERNAL_MESSAGE_CHANNEL) {
    // The message tool replaces ambient webchat context with an external route
    // encoded in the session key. Do not classify that route as a private sink.
    return !hasExternalSessionDeliveryRoute(input.sessionKey);
  }
  const currentMessageId = input.toolContext?.currentMessageId;
  return Boolean(
    normalizeOptionalString(input.toolContext?.currentChannelId) ||
    normalizeOptionalString(input.toolContext?.currentMessagingTarget) ||
    normalizeOptionalString(input.toolContext?.currentThreadTs) ||
    (typeof currentMessageId === "number" && Number.isFinite(currentMessageId)) ||
    normalizeOptionalString(currentMessageId),
  );
}

async function hasConfiguredCurrentSourceChannel(
  input: InternalSourceReplySinkInput,
): Promise<boolean> {
  const provider =
    normalizeMessageChannel(input.toolContext?.currentChannelProvider) ??
    normalizeOptionalLowercaseString(input.toolContext?.currentChannelProvider);
  if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  if (!isConfiguredChannel(input.cfg, provider)) {
    return false;
  }
  if (!resolveOutboundChannelPlugin({ channel: provider, cfg: input.cfg, allowBootstrap: true })) {
    return false;
  }
  const configuredChannels = await listConfiguredMessageChannels(input.cfg);
  return configuredChannels.some((channel) => channel === provider);
}

/** Return whether this send resolves to the private current-run source-reply sink. */
export async function shouldUseInternalSourceReplySink(
  input: InternalSourceReplySinkInput,
  params: Record<string, unknown>,
): Promise<boolean> {
  const hasImplicitCurrentSourceRoute =
    input.action === "send" &&
    input.sourceReplyDeliveryMode === "message_tool_only" &&
    hasCurrentSourceReplyContext(input) &&
    Boolean(input.sessionKey?.trim()) &&
    !hasExplicitRouteParam(params);
  if (!hasImplicitCurrentSourceRoute) {
    return false;
  }
  if (
    !normalizeOptionalString(input.toolContext?.currentChannelId) &&
    !normalizeOptionalString(input.toolContext?.currentMessagingTarget)
  ) {
    return true;
  }
  // Configured current-source channels can infer the target and deliver through
  // the normal plugin path; the sink is only the private fallback.
  return !(await hasConfiguredCurrentSourceChannel(input));
}
