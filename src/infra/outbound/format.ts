// Outbound delivery formatting produces human CLI summaries and JSON payloads
// for direct and gateway send results.
import { getChatChannelMeta } from "../../channels/chat-meta.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import type { OutboundDeliveryResult } from "./deliver.js";

/**
 * Machine-readable delivery result emitted by outbound send commands.
 */
export type OutboundDeliveryJson = {
  channel: string;
  via: "direct" | "gateway";
  to: string;
  messageId: string;
  mediaUrl: string | null;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  meta?: Record<string, unknown>;
};

type OutboundDeliveryMeta = {
  messageId?: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  meta?: Record<string, unknown>;
};

const resolveChannelLabel = (channel: string) => {
  const pluginLabel = getChannelPlugin(channel as ChannelId)?.meta.label;
  if (pluginLabel) {
    return pluginLabel;
  }
  // Some legacy chat channels are not plugins; keep their human labels for CLI output.
  const normalized = normalizeChatChannelId(channel);
  if (normalized) {
    return getChatChannelMeta(normalized).label;
  }
  return channel;
};

/**
 * Formats the human-readable direct delivery summary for CLI output.
 */
export function formatOutboundDeliverySummary(
  channel: string,
  result?: OutboundDeliveryResult,
): string {
  if (!result) {
    return `✅ Sent via ${resolveChannelLabel(channel)}. Message ID: unknown`;
  }

  const label = resolveChannelLabel(result.channel);
  const base = `✅ Sent via ${label}. Message ID: ${result.messageId}`;

  if ("chatId" in result) {
    return `${base} (chat ${result.chatId})`;
  }
  if ("channelId" in result) {
    return `${base} (channel ${result.channelId})`;
  }
  if ("roomId" in result) {
    return `${base} (room ${result.roomId})`;
  }
  if ("conversationId" in result) {
    return `${base} (conversation ${result.conversationId})`;
  }
  return base;
}

/**
 * Builds the JSON delivery payload returned by direct or gateway sends.
 */
export function buildOutboundDeliveryJson(params: {
  channel: string;
  to: string;
  result?: OutboundDeliveryMeta | OutboundDeliveryResult;
  via?: "direct" | "gateway";
  mediaUrl?: string | null;
}): OutboundDeliveryJson {
  const { channel, to, result } = params;
  const messageId = result?.messageId ?? "unknown";
  const payload: OutboundDeliveryJson = {
    channel,
    via: params.via ?? "direct",
    to,
    messageId,
    mediaUrl: params.mediaUrl ?? null,
  };

  if (result && "chatId" in result && result.chatId !== undefined) {
    payload.chatId = result.chatId;
  }
  if (result && "channelId" in result && result.channelId !== undefined) {
    payload.channelId = result.channelId;
  }
  if (result && "roomId" in result && result.roomId !== undefined) {
    payload.roomId = result.roomId;
  }
  if (result && "conversationId" in result && result.conversationId !== undefined) {
    payload.conversationId = result.conversationId;
  }
  if (result && "timestamp" in result && result.timestamp !== undefined) {
    payload.timestamp = result.timestamp;
  }
  if (result && "toJid" in result && result.toJid !== undefined) {
    payload.toJid = result.toJid;
  }
  if (result && "meta" in result && result.meta !== undefined) {
    payload.meta = result.meta;
  }

  return payload;
}

/**
 * Formats the human-readable gateway delivery summary for CLI output.
 */
export function formatGatewaySummary(params: {
  action?: string;
  channel?: string;
  messageId?: string | null;
}): string {
  const action = params.action ?? "Sent";
  const channelSuffix = params.channel ? ` (${params.channel})` : "";
  const messageId = params.messageId ?? "unknown";
  return `✅ ${action} via gateway${channelSuffix}. Message ID: ${messageId}`;
}
