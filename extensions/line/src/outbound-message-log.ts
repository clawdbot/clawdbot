// Line plugin module remembers which inbound quotes point at the bot's own messages.

// LINE's webhook reports a quoted message's id but never its author, so the only
// way to recognise our own message is to remember what we sent. Bounded and in
// memory on purpose: after a restart a quote stops counting as an address, which
// is exactly today's behaviour, rather than ever counting the wrong one.
const RECENT_SENT_LIMIT = 500;
const recentSentMessages = new Map<string, string>();

export function recordLineSentMessages(accountId: string, messageIds: readonly string[]): void {
  for (const messageId of messageIds) {
    // Re-insert so a resent id keeps the newest position against eviction.
    recentSentMessages.delete(messageId);
    recentSentMessages.set(messageId, accountId);
  }
  for (const messageId of recentSentMessages.keys()) {
    if (recentSentMessages.size <= RECENT_SENT_LIMIT) {
      break;
    }
    recentSentMessages.delete(messageId);
  }
}

// Message ids are unique per account, and LINE only lets a quote reference a
// message from the same conversation, so the account match is the whole check.
export function quotesLineBotMessage(
  accountId: string,
  quotedMessageId: string | undefined,
): boolean {
  return quotedMessageId !== undefined && recentSentMessages.get(quotedMessageId) === accountId;
}
