// Recent-queue message-id dedupe shared by enqueue admission and abandonment release.
import { pruneMapToMaxSize } from "../../../infra/map-size.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";

const RECENT_QUEUE_MESSAGE_ID_TTL_MS = 5 * 60 * 1000;
const RECENT_QUEUE_MESSAGE_ID_MAX_SIZE = 10_000;

type RecentQueueMessageIdRecord = {
  ownerToken: object;
  recordedAt: number;
};

type RecentQueueMessageIdOwnership = {
  key: string;
  ownerToken: object;
};

/**
 * Keep queued message-id dedupe shared across bundled chunks so redeliveries
 * are rejected no matter which chunk receives the enqueue call.
 */
const RECENT_QUEUE_MESSAGE_IDS = resolveGlobalSingleton(
  Symbol.for("openclaw.recentQueueMessageIdOwners"),
  () => new Map<string, RecentQueueMessageIdRecord>(),
);

/** Chunk-shared identity→key association so abandonment can free the entry. */
const DEDUPE_IDENTITY_OWNERSHIPS = resolveGlobalSingleton(
  Symbol.for("openclaw.recentQueueMessageIdOwnerships"),
  () => new WeakMap<object, RecentQueueMessageIdOwnership>(),
);

type DedupeOwnedRun = { turnAdoptionLifecycle?: object };

/**
 * The adoption lifecycle is the ownership identity that survives run cloning
 * (overflow-summary retry sources copy the lifecycle reference onto a new run
 * object), so it must key the association; completion release fires once per
 * lifecycle. Lifecycle-less runs never release, so keying them by the run
 * object keeps their entries for the full TTL.
 */
function resolveDedupeIdentity(run: DedupeOwnedRun): object {
  return run.turnAdoptionLifecycle ?? run;
}

function pruneRecentQueueMessageIds(now: number): void {
  const cutoff = now - RECENT_QUEUE_MESSAGE_ID_TTL_MS;
  for (const [key, record] of RECENT_QUEUE_MESSAGE_IDS) {
    if (record.recordedAt <= cutoff) {
      RECENT_QUEUE_MESSAGE_IDS.delete(key);
    }
  }
  pruneMapToMaxSize(RECENT_QUEUE_MESSAGE_IDS, RECENT_QUEUE_MESSAGE_ID_MAX_SIZE);
}

export function peekRecentQueueMessageId(key: string, now = Date.now()): boolean {
  const record = RECENT_QUEUE_MESSAGE_IDS.get(key);
  if (!record) {
    return false;
  }
  if (now - record.recordedAt >= RECENT_QUEUE_MESSAGE_ID_TTL_MS) {
    RECENT_QUEUE_MESSAGE_IDS.delete(key);
    return false;
  }
  return true;
}

export function recordRecentQueueMessageId(
  run: DedupeOwnedRun,
  key: string,
  now = Date.now(),
): void {
  const ownerToken = {};
  DEDUPE_IDENTITY_OWNERSHIPS.set(resolveDedupeIdentity(run), { key, ownerToken });
  RECENT_QUEUE_MESSAGE_IDS.delete(key);
  RECENT_QUEUE_MESSAGE_IDS.set(key, { ownerToken, recordedAt: now });
  pruneRecentQueueMessageIds(now);
}

/**
 * Frees a dropped run's dedupe identity. A run abandoned before admission makes
 * durable ingress release its claim for retry; that retry must be re-admittable
 * instead of being rejected as a recent duplicate.
 */
export function releaseRecentQueueMessageId(run: DedupeOwnedRun): void {
  const identity = resolveDedupeIdentity(run);
  const ownership = DEDUPE_IDENTITY_OWNERSHIPS.get(identity);
  if (!ownership) {
    return;
  }
  DEDUPE_IDENTITY_OWNERSHIPS.delete(identity);
  // The key may have expired and been re-recorded by a newer same-ID run.
  // Only the lifecycle that installed the current owner may release it.
  if (RECENT_QUEUE_MESSAGE_IDS.get(ownership.key)?.ownerToken === ownership.ownerToken) {
    RECENT_QUEUE_MESSAGE_IDS.delete(ownership.key);
  }
}

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
}
