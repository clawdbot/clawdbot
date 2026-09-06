// Line plugin module remembers which inbound quotes point at the bot's own messages.
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";

// LINE's webhook reports a quoted message's id but never its author, so the only
// way to recognize our own message is to remember what we sent. Bounded and in
// memory on purpose: after a restart a quote stops counting as an address, which
// is exactly today's behavior, rather than ever counting the wrong one.
const RECENT_SENT_LIMIT = 500;

// The bound is per account, not shared: LINE runs several configured accounts in
// one process, and a busy account must not evict a quiet one's ids or the quiet
// bot silently stops treating quotes of itself as being addressed. The registry
// only grows with configured accounts that have actually sent something.
const recentSentByAccount = new Map<string, ReturnType<typeof createDedupeCache>>();

function recentSentFor(accountId: string): ReturnType<typeof createDedupeCache> {
  const existing = recentSentByAccount.get(accountId);
  if (existing) {
    return existing;
  }
  const created = createDedupeCache({ ttlMs: 0, maxSize: RECENT_SENT_LIMIT });
  recentSentByAccount.set(accountId, created);
  return created;
}

export function recordLineSentMessages(accountId: string, messageIds: readonly string[]): void {
  if (messageIds.length === 0) {
    return;
  }
  const recentSent = recentSentFor(accountId);
  for (const messageId of messageIds) {
    // check() records the id and re-seats a resent one against eviction.
    recentSent.check(messageId);
  }
}

// Message ids are unique per account, and LINE only lets a quote reference a
// message from the same conversation, so the account match is the whole check.
export function quotesLineBotMessage(
  accountId: string,
  quotedMessageId: string | undefined,
): boolean {
  return recentSentByAccount.get(accountId)?.peek(quotedMessageId) ?? false;
}
