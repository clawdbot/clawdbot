// Voice Call plugin module owns bounded webhook replay tracking.
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";

const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const REPLAY_CACHE_MAX_ENTRIES = 10_000;
const REPLAY_CACHE_PRUNE_INTERVAL = 64;

type WebhookReplayCache = {
  seenUntil: Map<string, number>;
  calls: number;
};

export function createWebhookReplayCache(): WebhookReplayCache {
  return { seenUntil: new Map<string, number>(), calls: 0 };
}

function pruneWebhookReplayCache(cache: WebhookReplayCache, now: number): void {
  for (const [key, expiresAt] of cache.seenUntil) {
    if (!isFutureDateTimestampMs(expiresAt, { nowMs: now })) {
      cache.seenUntil.delete(key);
    }
  }
  while (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    const oldest = cache.seenUntil.keys().next().value;
    if (!oldest) {
      break;
    }
    cache.seenUntil.delete(oldest);
  }
}

export function markWebhookReplay(cache: WebhookReplayCache, replayKey: string): boolean {
  const now = Date.now();
  cache.calls += 1;
  if (cache.calls % REPLAY_CACHE_PRUNE_INTERVAL === 0) {
    pruneWebhookReplayCache(cache, now);
  }

  const existing = cache.seenUntil.get(replayKey);
  if (existing !== undefined && isFutureDateTimestampMs(existing, { nowMs: now })) {
    return true;
  }

  const expiresAt = resolveExpiresAtMsFromDurationMs(REPLAY_WINDOW_MS, { nowMs: now });
  if (expiresAt !== undefined) {
    cache.seenUntil.set(replayKey, expiresAt);
  }
  if (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    pruneWebhookReplayCache(cache, now);
  }
  return false;
}
