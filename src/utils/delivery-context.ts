import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "./message-channel.js";
export {
  deliveryContextFromSession,
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "./delivery-context.shared.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";

type ConversationTargetParams = {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
};

function normalizeConversationId(value: string | number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.trunc(value))
    : typeof value === "string"
      ? normalizeOptionalString(value)
      : undefined;
}

function normalizeConversationTargetParams(params: ConversationTargetParams): {
  channel?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId = normalizeConversationId(params.conversationId);
  const parentConversationId = normalizeConversationId(params.parentConversationId);
  return { channel, conversationId, parentConversationId };
}

export function formatConversationTarget(params: ConversationTargetParams): string | undefined {
  const { channel, conversationId, parentConversationId } =
    normalizeConversationTargetParams(params);
  if (!channel || !conversationId) {
    return undefined;
  }
  const pluginTarget = normalizeChannelId(channel)
    ? getChannelPlugin(normalizeChannelId(channel)!)?.messaging?.resolveDeliveryTarget?.({
        conversationId,
        parentConversationId,
      })
    : null;
  if (pluginTarget?.to?.trim()) {
    return pluginTarget.to.trim();
  }
  return `channel:${conversationId}`;
}

export function resolveConversationDeliveryTarget(params: {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
}): { to?: string; threadId?: string } {
  const { channel, conversationId, parentConversationId } =
    normalizeConversationTargetParams(params);
  const pluginTarget =
    channel && conversationId
      ? getChannelPlugin(
          normalizeChannelId(channel) ?? channel,
        )?.messaging?.resolveDeliveryTarget?.({
          conversationId,
          parentConversationId,
        })
      : null;
  if (pluginTarget) {
    return {
      ...(pluginTarget.to?.trim() ? { to: pluginTarget.to.trim() } : {}),
      ...(pluginTarget.threadId?.trim() ? { threadId: pluginTarget.threadId.trim() } : {}),
    };
  }
  const to = formatConversationTarget(params);
  return { to };
}
