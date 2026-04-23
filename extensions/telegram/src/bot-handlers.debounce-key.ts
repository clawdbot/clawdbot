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
  threadId?: number | null;
}): string {
  return params.threadId != null
    ? `${params.chatId}:topic:${params.threadId}`
    : String(params.chatId);
}
