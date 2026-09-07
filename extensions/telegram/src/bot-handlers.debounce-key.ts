// Telegram plugin module implements bot handlersebounce key behavior.
import { buildTelegramGroupPeerId, type TelegramThreadSpec } from "./bot/helpers.js";
export function buildTelegramInboundDebounceKey(params: {
  accountId?: string | null;
  conversationKey: string;
  senderId: string;
  debounceLane: "default" | "forward";
}): string {
  const resolvedAccountId = params.accountId?.trim() || "default";
  return `telegram:${resolvedAccountId}:${params.conversationKey}:${params.senderId}:${params.debounceLane}`;
}

export function buildTelegramInboundDebounceConversationKey(params: {
  chatId: number | string;
  threadSpec: TelegramThreadSpec;
}): string {
  return buildTelegramGroupPeerId(params.chatId, params.threadSpec);
}
