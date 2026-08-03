import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeMessageChannel } from "./message-channel.js";

export type ConversationTargetParams = {
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

export function normalizeConversationTargetParams(params: ConversationTargetParams): {
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
