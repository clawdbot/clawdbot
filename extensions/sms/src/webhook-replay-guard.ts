import { performance } from "node:perf_hooks";

const REPLAY_CACHE_TTL_MS = 10 * 60_000;
const REPLAY_CACHE_MAX_KEYS = 10_000;

type ReplayCacheDecision =
  | { kind: "accepted" }
  | { kind: "replayed" }
  | { kind: "saturated"; retryAfterMs: number };

export type SmsWebhookReplayGuard = {
  remember: (messageSid: string) => ReplayCacheDecision;
};

export function createSmsWebhookReplayGuard(
  options: {
    ttlMs?: number;
    maxKeys?: number;
    now?: () => number;
  } = {},
): SmsWebhookReplayGuard {
  const ttlMs = options.ttlMs ?? REPLAY_CACHE_TTL_MS;
  const maxKeys = options.maxKeys ?? REPLAY_CACHE_MAX_KEYS;
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, number>();

  const pruneExpired = (nowMs: number) => {
    // Fixed TTLs on a monotonic clock expire in insertion order, so only inspect
    // the expired prefix. Full live caches stay O(1) instead of rescanning 10k keys.
    for (const [key, expiresAt] of entries) {
      if (expiresAt > nowMs) {
        break;
      }
      entries.delete(key);
    }
  };

  return {
    remember: (messageSid) => {
      const nowMs = now();
      pruneExpired(nowMs);
      if (entries.has(messageSid)) {
        return { kind: "replayed" };
      }
      if (entries.size >= maxKeys) {
        const oldestExpiresAt = entries.values().next().value ?? nowMs;
        return {
          kind: "saturated",
          retryAfterMs: Math.max(0, oldestExpiresAt - nowMs),
        };
      }
      entries.set(messageSid, nowMs + ttlMs);
      return { kind: "accepted" };
    },
  };
}
