// Voice Call plugin module owns bounded webhook replay tracking.
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";

const REPLAY_WINDOW_MS = 10 * 60 * 1000;
const REPLAY_CACHE_MAX_ENTRIES = 10_000;
const REPLAY_CACHE_PRUNE_INTERVAL = 64;

type WebhookReplayCache = {
  seenUntil: Map<string, { expiresAt: number }>;
  calls: number;
};

type WebhookReplayReservation = {
  isReplay: boolean;
  verifiedRequestKey: string;
  releaseReplay?: () => void;
};

export function createWebhookReplayCache(): WebhookReplayCache {
  return { seenUntil: new Map<string, { expiresAt: number }>(), calls: 0 };
}

function pruneWebhookReplayCache(cache: WebhookReplayCache, now: number): void {
  for (const [key, reservation] of cache.seenUntil) {
    if (!isFutureDateTimestampMs(reservation.expiresAt, { nowMs: now })) {
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

export function reserveWebhookReplay(
  cache: WebhookReplayCache,
  replayKey: string,
): WebhookReplayReservation {
  const now = Date.now();
  cache.calls += 1;
  if (cache.calls % REPLAY_CACHE_PRUNE_INTERVAL === 0) {
    pruneWebhookReplayCache(cache, now);
  }

  const existing = cache.seenUntil.get(replayKey);
  if (existing !== undefined && isFutureDateTimestampMs(existing.expiresAt, { nowMs: now })) {
    return { isReplay: true, verifiedRequestKey: replayKey };
  }

  const expiresAt = resolveExpiresAtMsFromDurationMs(REPLAY_WINDOW_MS, { nowMs: now });
  if (expiresAt === undefined) {
    return { isReplay: false, verifiedRequestKey: replayKey };
  }
  const reservation = { expiresAt };
  cache.seenUntil.set(replayKey, reservation);
  if (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    pruneWebhookReplayCache(cache, now);
  }
  return {
    isReplay: false,
    verifiedRequestKey: replayKey,
    // An older failed delivery must never clear a newer same-key reservation.
    releaseReplay: () => {
      if (cache.seenUntil.get(replayKey) === reservation) {
        cache.seenUntil.delete(replayKey);
      }
    },
  };
}
