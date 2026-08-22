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
import {
  CHAT_SNAPSHOT_DB_NAME,
  deleteSessionSnapshotDatabaseRecord,
} from "./session-snapshot-database.ts";
import { publishSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

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
