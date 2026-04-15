const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MSTEAMS_SENT_MESSAGES_KEY = Symbol.for("openclaw.msteamsSentMessages");

let sentMessageCache: Map<string, Map<string, number>> | undefined;

function getSentMessageCache(): Map<string, Map<string, number>> {
  if (!sentMessageCache) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    sentMessageCache =
      (globalStore[MSTEAMS_SENT_MESSAGES_KEY] as Map<string, Map<string, number>> | undefined) ??
      new Map<string, Map<string, number>>();
    globalStore[MSTEAMS_SENT_MESSAGES_KEY] = sentMessageCache;
  }
  return sentMessageCache;
}

function cleanupExpired(scopeKey: string, entry: Map<string, number>, now: number): void {
  for (const [id, timestamp] of entry) {
    if (now - timestamp > TTL_MS) {
      entry.delete(id);
    }
  }
  if (entry.size === 0) {
    getSentMessageCache().delete(scopeKey);
  }
}

export function recordMSTeamsSentMessage(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) {
    return;
  }
  const now = Date.now();
  const store = getSentMessageCache();
  let entry = store.get(conversationId);
  if (!entry) {
    entry = new Map<string, number>();
    store.set(conversationId, entry);
  }
  entry.set(messageId, now);
  if (entry.size > 200) {
    cleanupExpired(conversationId, entry, now);
  }
}

export function wasMSTeamsMessageSent(conversationId: string, messageId: string): boolean {
  const entry = getSentMessageCache().get(conversationId);
  if (!entry) {
    return false;
  }
  cleanupExpired(conversationId, entry, Date.now());
  return entry.has(messageId);
}

export function clearMSTeamsSentMessageCache(): void {
  getSentMessageCache().clear();
}
