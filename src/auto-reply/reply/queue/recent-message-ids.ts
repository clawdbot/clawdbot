// Recent-queue message-id dedupe shared by enqueue admission and abandonment release.
import { resolveGlobalDedupeCache } from "../../../infra/dedupe.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";

/**
 * Keep queued message-id dedupe shared across bundled chunks so redeliveries
 * are rejected no matter which chunk receives the enqueue call.
 */
const RECENT_QUEUE_MESSAGE_IDS_KEY = Symbol.for("openclaw.recentQueueMessageIds");

const RECENT_QUEUE_MESSAGE_IDS = resolveGlobalDedupeCache(RECENT_QUEUE_MESSAGE_IDS_KEY, {
  ttlMs: 5 * 60 * 1000,
  maxSize: 10_000,
});

/** Chunk-shared run→identity association so abandonment can free the entry by object identity. */
const RUN_MESSAGE_ID_KEYS = resolveGlobalSingleton(
  Symbol.for("openclaw.recentQueueMessageIdKeys"),
  () => new WeakMap<object, string>(),
);

export function peekRecentQueueMessageId(key: string): boolean {
  return RECENT_QUEUE_MESSAGE_IDS.peek(key);
}

export function recordRecentQueueMessageId(run: object, key: string): void {
  RUN_MESSAGE_ID_KEYS.set(run, key);
  RECENT_QUEUE_MESSAGE_IDS.check(key);
}

/**
 * Frees a dropped run's dedupe identity. A run abandoned before admission makes
 * durable ingress release its claim for retry; that retry must be re-admittable
 * instead of being rejected as a recent duplicate.
 */
export function releaseRecentQueueMessageId(run: object): void {
  const key = RUN_MESSAGE_ID_KEYS.get(run);
  if (key === undefined) {
    return;
  }
  RUN_MESSAGE_ID_KEYS.delete(run);
  RECENT_QUEUE_MESSAGE_IDS.delete(key);
}

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
}
