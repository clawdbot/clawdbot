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

export function formatConversationTarget(params: {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
}): string | undefined {
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? String(Math.trunc(params.conversationId))
      : typeof params.conversationId === "string"
        ? normalizeOptionalString(params.conversationId)
        : undefined;
  if (!channel || !conversationId) {
    return undefined;
  }
  const parentConversationId =
    typeof params.parentConversationId === "number" && Number.isFinite(params.parentConversationId)
      ? String(Math.trunc(params.parentConversationId))
      : typeof params.parentConversationId === "string"
        ? normalizeOptionalString(params.parentConversationId)
        : undefined;
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
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? String(Math.trunc(params.conversationId))
      : typeof params.conversationId === "string"
        ? normalizeOptionalString(params.conversationId)
        : undefined;
  const parentConversationId =
    typeof params.parentConversationId === "number" && Number.isFinite(params.parentConversationId)
      ? String(Math.trunc(params.parentConversationId))
      : typeof params.parentConversationId === "string"
        ? normalizeOptionalString(params.parentConversationId)
        : undefined;
  const isThreadChild =
    conversationId && parentConversationId && parentConversationId !== conversationId;
  if (channel && isThreadChild) {
    if (channel === "matrix") {
      return {
        to: `room:${parentConversationId}`,
        threadId: conversationId,
      };
    }
    if (channel === "slack" || channel === "mattermost" || channel === "telegram") {
      return {
        to: `channel:${parentConversationId}`,
        threadId: conversationId,
      };
    }
  }
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
