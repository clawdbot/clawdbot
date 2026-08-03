// Outbound delivery formatting produces human CLI summaries for direct and
// gateway send results.
import { findChatChannelMeta } from "../../channels/chat-meta.js";
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

const resolveChannelLabel = (channel: string) => {
  const pluginLabel = getChannelPlugin(channel as ChannelId)?.meta.label;
  if (pluginLabel) {
    return pluginLabel;
  }
  // Some legacy chat channels are not plugins; keep their human labels for CLI output.
  const normalized = normalizeChatChannelId(channel);
  if (normalized) {
    return findChatChannelMeta(normalized)?.label ?? channel;
  }
  return channel;
};

/**
 * Formats the human-readable direct delivery summary for CLI output.
 */
export function formatOutboundDeliverySummary(
  channel: string,
  result?: OutboundDeliveryResult,
  opts?: { action?: string },
): string {
  const action = opts?.action ?? "Sent";
  if (!result) {
    return `✅ ${action} via ${resolveChannelLabel(channel)}. Message ID: unknown`;
  }

  const label = resolveChannelLabel(result.channel);
  const base = `✅ ${action} via ${label}. Message ID: ${result.messageId}`;

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
