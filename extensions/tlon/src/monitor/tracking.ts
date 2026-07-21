// Tlon monitor module owns bounded and snapshot-scoped identifier tracking.
import { createDedupeCache } from "../../runtime-api.js";

const TLON_PARTICIPATED_THREAD_LIMIT = 2_000;

export function createParticipatedThreadTracker(limit = TLON_PARTICIPATED_THREAD_LIMIT) {
  const cache = createDedupeCache({ ttlMs: 0, maxSize: limit });

  return {
    add: (parentId: string) => {
      cache.check(parentId);
    },
    has: (parentId: string) => {
      if (!cache.peek(parentId)) {
        return false;
      }
      // Mention-free replies refresh recency before older participation is evicted.
      cache.check(parentId);
      return true;
    },
  };
}

export function createActiveSnapshotTracker() {
  const processed = new Set<string>();

  return {
    beginSnapshot: (keys: Iterable<string>): ReadonlySet<string> => {
      const active = new Set(keys);
      for (const key of processed) {
        if (!active.has(key)) {
          processed.delete(key);
        }
      }
      return active;
    },
    has: (key: string) => processed.has(key),
    add: (key: string) => processed.add(key),
  };
}
