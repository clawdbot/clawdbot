import {
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

export const CHAT_SNAPSHOT_DB_NAME = "openclaw-chat-snapshots";
export const CHAT_SNAPSHOT_STORE_NAME = "snapshots";

type SnapshotInvalidation = { sessionKey: string } | { sessionKey?: undefined };
type SnapshotInvalidationListener = (invalidation: SnapshotInvalidation) => void | Promise<void>;

const invalidationListeners = new Set<SnapshotInvalidationListener>();

type ChatSnapshotKeyHost = Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello">;

type ChatSnapshotKeyTarget = {
  sessionKey: string;
  agentId?: string | null;
};

export function resolveChatSnapshotKey(
  host: ChatSnapshotKeyHost,
  target: ChatSnapshotKeyTarget,
): string {
  const parsed = parseAgentSessionKey(target.sessionKey);
  const explicitAgentId = target.agentId?.trim();
  const agentId = explicitAgentId
    ? normalizeAgentId(explicitAgentId)
    : parsed
      ? normalizeAgentId(parsed.agentId)
      : isUiGlobalSessionKey(target.sessionKey)
        ? resolveUiSelectedGlobalAgentId(host)
        : resolveUiDefaultAgentId(host);
  const normalizedSessionKey = normalizeSessionKeyForUiComparison(target.sessionKey);
  const normalized = parsed
    ? normalizedSessionKey.split(":").slice(2).join(":")
    : normalizedSessionKey;
  const configuredMainKey = resolveUiConfiguredMainKey(host);
  const sessionKey =
    isUiGlobalSessionKey(target.sessionKey) ||
    normalized === DEFAULT_MAIN_KEY ||
    normalized === configuredMainKey
      ? DEFAULT_MAIN_KEY
      : normalized;
  return `agent:${agentId}:${sessionKey}`;
}

export function subscribeSnapshotInvalidation(listener: SnapshotInvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

async function notifySnapshotInvalidation(invalidation: SnapshotInvalidation): Promise<void> {
  await Promise.all(
    [...invalidationListeners].map((listener) => Promise.resolve(listener(invalidation))),
  );
}

function indexedDbFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

export async function deleteStoredChatSnapshot(sessionKey: string): Promise<void> {
  await notifySnapshotInvalidation({ sessionKey });
  const factory = indexedDbFactory();
  if (!factory) {
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const request = factory.open(CHAT_SNAPSHOT_DB_NAME);
      request.addEventListener("error", () => resolve());
      request.addEventListener("blocked", () => resolve());
      request.addEventListener("success", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CHAT_SNAPSHOT_STORE_NAME)) {
          database.close();
          resolve();
          return;
        }
        const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
        transaction.addEventListener("complete", () => {
          database.close();
          resolve();
        });
        const settleFailure = () => {
          database.close();
          resolve();
        };
        transaction.addEventListener("error", settleFailure);
        transaction.addEventListener("abort", settleFailure);
        transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).delete(sessionKey);
      });
    });
  } catch {}
}

export async function clearStoredChatSnapshots(): Promise<void> {
  await notifySnapshotInvalidation({});
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
