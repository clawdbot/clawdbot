const EVENT_DEDUP_TTL_MS = 5 * 60 * 1000;
const EVENT_MEMORY_MAX_SIZE = 2_000;

const processingClaims = new Map<string, number>();

function resolveEventDedupeKey(
  namespace: string,
  messageId: string | undefined | null,
): string | null {
  const trimmed = messageId?.trim();
  return trimmed ? `${namespace}:${trimmed}` : null;
}

function pruneProcessingClaims(now: number): void {
  const cutoff = now - EVENT_DEDUP_TTL_MS;
  for (const [key, seenAt] of processingClaims) {
    if (seenAt < cutoff) {
      processingClaims.delete(key);
    }
  }
  while (processingClaims.size > EVENT_MEMORY_MAX_SIZE) {
    const oldestKey = processingClaims.keys().next().value;
    if (!oldestKey) {
      return;
    }
    processingClaims.delete(oldestKey);
  }
}

export function tryBeginFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): boolean {
  const key = resolveEventDedupeKey(namespace, messageId);
  if (!key) {
    return true;
  }
  const now = Date.now();
  pruneProcessingClaims(now);
  if (processingClaims.has(key)) {
    processingClaims.delete(key);
    processingClaims.set(key, now);
    pruneProcessingClaims(now);
    return false;
  }
  processingClaims.set(key, now);
  pruneProcessingClaims(now);
  return true;
}

export function releaseFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): void {
  const key = resolveEventDedupeKey(namespace, messageId);
  if (key) {
    processingClaims.delete(key);
  }
}
