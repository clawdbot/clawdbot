type SnapshotInvalidation = { sessionKey: string } | { sessionKey?: undefined };

type SnapshotInvalidationListener = (invalidation: SnapshotInvalidation) => void | Promise<void>;

const SNAPSHOT_INVALIDATION_STORAGE_KEY = "openclaw.control.chatSnapshots.invalidate.v1";
const invalidationListeners = new Set<SnapshotInvalidationListener>();

function notifySnapshotInvalidation(invalidation: SnapshotInvalidation): Promise<void> {
  return Promise.all(
    [...invalidationListeners].map((listener) => Promise.resolve(listener(invalidation))),
  ).then(() => undefined);
}

function broadcastSnapshotInvalidation(invalidation: SnapshotInvalidation): void {
  try {
    localStorage.setItem(SNAPSHOT_INVALIDATION_STORAGE_KEY, JSON.stringify(invalidation));
    localStorage.removeItem(SNAPSHOT_INVALIDATION_STORAGE_KEY);
  } catch {}
}

function parseSnapshotInvalidation(value: string): SnapshotInvalidation {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "sessionKey" in parsed &&
      typeof parsed.sessionKey === "string" &&
      parsed.sessionKey
    ) {
      return { sessionKey: parsed.sessionKey };
    }
  } catch {}
  // Counter values from older tabs carried no scope, so they still retire every snapshot.
  return {};
}

export function publishSnapshotInvalidation(invalidation: SnapshotInvalidation): Promise<void> {
  const notified = notifySnapshotInvalidation(invalidation);
  broadcastSnapshotInvalidation(invalidation);
  return notified;
}

export function subscribeSnapshotInvalidation(listener: SnapshotInvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === SNAPSHOT_INVALIDATION_STORAGE_KEY && event.newValue !== null) {
      void notifySnapshotInvalidation(parseSnapshotInvalidation(event.newValue)).catch(
        (error: unknown) => {
          console.error("[chat-snapshot-cache] cross-tab invalidation failed", error);
        },
      );
    }
  });
}
