import {
  snapshotStoreGeneration,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation-events.ts";

type PrewarmedSnapshot = {
  cacheKey: string;
  cancelled: boolean;
  promise: Promise<unknown>;
  readyAt?: number;
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
    promise: import("./session-snapshot-database.ts")
      .then(({ readStoredChatSnapshotRecord }) => readStoredChatSnapshotRecord(cacheKey))
      .then((record) =>
        entry.cancelled || generation !== snapshotStoreGeneration ? undefined : record,
      )
      .catch(() => undefined),
  };
  pending = entry;
}

export function consumePrewarmedChatSnapshot(
  cacheKey: string,
): Pick<PrewarmedSnapshot, "promise" | "readyAt"> | undefined {
  if (pending?.cacheKey !== cacheKey) {
    return undefined;
  }
  const prewarm = pending;
  pending = undefined;
  return prewarm;
}

export function markPrewarmedChatSnapshotReady(): void {
  if (pending) {
    pending.readyAt ??= Date.now();
  }
}
subscribeSnapshotInvalidation(({ sessionKey }) => discardPrewarmedChatSnapshot(sessionKey));
