import { getProviderPlugin } from "../../providers/plugins/index.js";
import type { ProviderId } from "../../providers/plugins/types.js";
import type { OutboundDeliveryResult } from "./deliver.js";

export type OutboundDeliveryJson = {
  provider: string;
  via: "direct" | "gateway";
  to: string;
  messageId: string;
  mediaUrl: string | null;
  chatId?: string;
  channelId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
};

type OutboundDeliveryMeta = {
  messageId?: string;
  chatId?: string;
  channelId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
};

const resolveProviderLabel = (provider: string) =>
  getProviderPlugin(provider as ProviderId)?.meta.label ?? provider;

export function formatOutboundDeliverySummary(
  provider: string,
  result?: OutboundDeliveryResult,
): string {
  if (!result) {
    return `✅ Sent via ${resolveProviderLabel(provider)}. Message ID: unknown`;
  }

  const label = resolveProviderLabel(result.provider);
  const base = `✅ Sent via ${label}. Message ID: ${result.messageId}`;

  if ("chatId" in result) return `${base} (chat ${result.chatId})`;
  if ("channelId" in result) return `${base} (channel ${result.channelId})`;
  if ("conversationId" in result)
    return `${base} (conversation ${result.conversationId})`;
  return base;
}

export function buildOutboundDeliveryJson(params: {
  provider: string;
  to: string;
  result?: OutboundDeliveryMeta | OutboundDeliveryResult;
  via?: "direct" | "gateway";
  mediaUrl?: string | null;
}): OutboundDeliveryJson {
  const { provider, to, result } = params;
  const messageId = result?.messageId ?? "unknown";
  const payload: OutboundDeliveryJson = {
    provider,
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
  if (
    result &&
    "conversationId" in result &&
    result.conversationId !== undefined
  ) {
    payload.conversationId = result.conversationId;
  }
  if (result && "timestamp" in result && result.timestamp !== undefined) {
    payload.timestamp = result.timestamp;
  }
  if (result && "toJid" in result && result.toJid !== undefined) {
    payload.toJid = result.toJid;
  }

  return payload;
}

export function formatGatewaySummary(params: {
  action?: string;
  provider?: string;
  messageId?: string | null;
}): string {
  const action = params.action ?? "Sent";
  const providerSuffix = params.provider ? ` (${params.provider})` : "";
  const messageId = params.messageId ?? "unknown";
  return `✅ ${action} via gateway${providerSuffix}. Message ID: ${messageId}`;
}
