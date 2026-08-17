export type SnapshotInvalidation = { sessionKey: string } | { sessionKey?: undefined };

type SnapshotInvalidationListener = (invalidation: SnapshotInvalidation) => void | Promise<void>;

const SNAPSHOT_INVALIDATION_STORAGE_KEY = "openclaw.control.chatSnapshots.invalidate.v1";
const invalidationListeners = new Set<SnapshotInvalidationListener>();
let broadcastVersion = 0;

function notifySnapshotInvalidation(invalidation: SnapshotInvalidation): Promise<void> {
  return Promise.all(
    [...invalidationListeners].map((listener) => Promise.resolve(listener(invalidation))),
  ).then(() => undefined);
}

function broadcastSnapshotInvalidation(): void {
  try {
    localStorage.setItem(SNAPSHOT_INVALIDATION_STORAGE_KEY, String(++broadcastVersion));
    localStorage.removeItem(SNAPSHOT_INVALIDATION_STORAGE_KEY);
  } catch {}
}

export function publishSnapshotInvalidation(invalidation: SnapshotInvalidation): Promise<void> {
  const notified = notifySnapshotInvalidation(invalidation);
  broadcastSnapshotInvalidation();
  return notified;
}

export function subscribeSnapshotInvalidation(listener: SnapshotInvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === SNAPSHOT_INVALIDATION_STORAGE_KEY && event.newValue !== null) {
      // The cross-tab signal carries no session identifiers; peers safely drop all memory state.
      void notifySnapshotInvalidation({}).catch((error) => {
        console.error("[chat-snapshot-cache] cross-tab invalidation failed", error);
      });
    }
  });
}
