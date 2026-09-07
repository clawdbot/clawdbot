import type { ChatSessionSnapshot } from "./session-message-cache.ts";
import {
  snapshotStoreGeneration,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

type PrewarmedSnapshot = {
  cacheKey: string;
  cancelled: boolean;
  promise: Promise<ChatSessionSnapshot | null>;
};

let pending: PrewarmedSnapshot | undefined;

export function discardPrewarmedChatSnapshot(cacheKey?: string): void {
  if (pending && (cacheKey === undefined || pending.cacheKey === cacheKey)) {
    pending.cancelled = true;
    pending = undefined;
  }
}

export function prewarmChatSnapshot(cacheKey: string): void {
  discardPrewarmedChatSnapshot();
  const generation = snapshotStoreGeneration;
  const entry: PrewarmedSnapshot = {
    cacheKey,
    cancelled: false,
    promise: import("./session-snapshot-store.ts")
      .then(async ({ readStoredChatSnapshot }) => {
        if (entry.cancelled || generation !== snapshotStoreGeneration) {
          return null;
        }
        const snapshot = await readStoredChatSnapshot(cacheKey);
        return entry.cancelled || generation !== snapshotStoreGeneration ? null : snapshot;
      })
      .catch(() => null),
  };
  pending = entry;
}

export function consumePrewarmedChatSnapshot(
  cacheKey: string,
): Promise<ChatSessionSnapshot | null> | undefined {
  if (pending?.cacheKey !== cacheKey) {
    return undefined;
  }
  const { promise } = pending;
  pending = undefined;
  return promise;
}

// Subscribe before the lazy reader loads so invalidation also fences its import.
subscribeSnapshotInvalidation(({ sessionKey }) => discardPrewarmedChatSnapshot(sessionKey));
