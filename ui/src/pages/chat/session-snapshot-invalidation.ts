import {
  CHAT_SNAPSHOT_DB_NAME,
  deleteSessionSnapshotDatabaseRecord,
} from "./session-snapshot-database.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

function indexedDbFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

export async function deleteStoredChatSnapshot(sessionKey: string): Promise<void> {
  await publishSnapshotInvalidation({ sessionKey });
  await deleteSessionSnapshotDatabaseRecord(sessionKey);
}

export async function clearStoredChatSnapshotStorage(): Promise<void> {
  const factory = indexedDbFactory();
  if (!factory) {
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const request = factory.deleteDatabase(CHAT_SNAPSHOT_DB_NAME);
      request.addEventListener("success", () => resolve());
      request.addEventListener("error", () => resolve());
      request.addEventListener("blocked", () => resolve());
    });
  } catch {}
}

export async function clearStoredChatSnapshots(): Promise<void> {
  await publishSnapshotInvalidation({});
  await clearStoredChatSnapshotStorage();
}
