import type {
  ZoomConversationStore,
  ZoomConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";
import { resolveZoomStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

type ConversationStoreData = {
  version: 1;
  conversations: Record<string, StoredConversationReference & { lastSeenAt?: string }>;
};

const STORE_FILENAME = "zoom-conversations.json";
const MAX_CONVERSATIONS = 1000;
const CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function pruneToLimit(
  conversations: Record<string, StoredConversationReference & { lastSeenAt?: string }>,
) {
  const entries = Object.entries(conversations);
  if (entries.length <= MAX_CONVERSATIONS) return conversations;

  entries.sort((a, b) => {
    const aTs = parseTimestamp(a[1].lastSeenAt) ?? 0;
    const bTs = parseTimestamp(b[1].lastSeenAt) ?? 0;
    return aTs - bTs;
  });

  const keep = entries.slice(entries.length - MAX_CONVERSATIONS);
  return Object.fromEntries(keep);
}

function pruneExpired(
  conversations: Record<string, StoredConversationReference & { lastSeenAt?: string }>,
  nowMs: number,
  ttlMs: number,
) {
  let removed = false;
  const kept: typeof conversations = {};
  for (const [conversationId, reference] of Object.entries(conversations)) {
    const lastSeenAt = parseTimestamp(reference.lastSeenAt);
    // Preserve legacy entries that have no lastSeenAt until they're seen again.
    if (lastSeenAt != null && nowMs - lastSeenAt > ttlMs) {
      removed = true;
      continue;
    }
    kept[conversationId] = reference;
  }
  return { conversations: kept, removed };
}

export function createZoomConversationStoreFs(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  ttlMs?: number;
  stateDir?: string;
  storePath?: string;
}): ZoomConversationStore {
  const ttlMs = params?.ttlMs ?? CONVERSATION_TTL_MS;
  const filePath = resolveZoomStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });

  const empty: ConversationStoreData = { version: 1, conversations: {} };

  const readStore = async (): Promise<ConversationStoreData> => {
    const { value } = await readJsonFile<ConversationStoreData>(filePath, empty);
    if (
      value.version !== 1 ||
      !value.conversations ||
      typeof value.conversations !== "object" ||
      Array.isArray(value.conversations)
    ) {
      return empty;
    }
    const nowMs = Date.now();
    const pruned = pruneExpired(value.conversations, nowMs, ttlMs).conversations;
    return { version: 1, conversations: pruneToLimit(pruned) };
  };

  const list = async (): Promise<ZoomConversationStoreEntry[]> => {
    const store = await readStore();
    return Object.entries(store.conversations).map(([conversationId, reference]) => ({
      conversationId,
      reference,
    }));
  };

  const get = async (conversationId: string): Promise<StoredConversationReference | null> => {
    const store = await readStore();
    return store.conversations[conversationId] ?? null;
  };

  const findByUserJid = async (jid: string): Promise<ZoomConversationStoreEntry | null> => {
    const target = jid.trim();
    if (!target) return null;
    for (const entry of await list()) {
      const { conversationId, reference } = entry;
      if (reference.userJid === target) {
        return { conversationId, reference };
      }
    }
    return null;
  };

  const upsert = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    await withFileLock(filePath, empty, async () => {
      const store = await readStore();
      store.conversations[conversationId] = {
        ...reference,
        lastSeenAt: new Date().toISOString(),
      };
      const nowMs = Date.now();
      store.conversations = pruneExpired(store.conversations, nowMs, ttlMs).conversations;
      store.conversations = pruneToLimit(store.conversations);
      await writeJsonFile(filePath, store);
    });
  };

  const remove = async (conversationId: string): Promise<boolean> => {
    return await withFileLock(filePath, empty, async () => {
      const store = await readStore();
      if (!(conversationId in store.conversations)) return false;
      delete store.conversations[conversationId];
      await writeJsonFile(filePath, store);
      return true;
    });
  };

  return { upsert, get, list, remove, findByUserJid };
}
