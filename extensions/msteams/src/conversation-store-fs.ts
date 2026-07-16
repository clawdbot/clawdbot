import {
  findPreferredDmConversationByUserId,
  mergeStoredConversationReference,
  normalizeStoredConversationId,
  parseStoredConversationTimestamp,
  toConversationStoreEntries,
} from "./conversation-store-helpers.js";
import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

type ConversationStoreData = {
  version: 1;
  conversations: Record<string, StoredConversationReference>;
};

const STORE_FILENAME = "msteams-conversations.json";
const MAX_CONVERSATIONS = 1000;
const CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function pruneToLimit(conversations: Record<string, StoredConversationReference>) {
  const entries = Object.entries(conversations);
  if (entries.length <= MAX_CONVERSATIONS) {
    return conversations;
  }

  entries.sort((a, b) => {
    const aTs = parseStoredConversationTimestamp(a[1].lastSeenAt) ?? 0;
    const bTs = parseStoredConversationTimestamp(b[1].lastSeenAt) ?? 0;
    return aTs - bTs;
  });

  const keep = entries.slice(entries.length - MAX_CONVERSATIONS);
  return Object.fromEntries(keep);
}

function pruneExpired(
  conversations: Record<string, StoredConversationReference>,
  nowMs: number,
  ttlMs: number,
) {
  let removed = false;
  const kept: typeof conversations = {};
  for (const [conversationId, reference] of Object.entries(conversations)) {
    const lastSeenAt = parseStoredConversationTimestamp(reference.lastSeenAt);
    // Preserve legacy entries that have no lastSeenAt until they're seen again.
    if (lastSeenAt != null && nowMs - lastSeenAt > ttlMs) {
      removed = true;
      continue;
    }
    kept[conversationId] = reference;
  }
  return { conversations: kept, removed };
}

export function createMSTeamsConversationStoreFs(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  ttlMs?: number;
  stateDir?: string;
  storePath?: string;
}): MSTeamsConversationStore {
  const ttlMs = params?.ttlMs ?? CONVERSATION_TTL_MS;
  const filePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });

  const empty: ConversationStoreData = { version: 1, conversations: {} };

  const readStore = async (): Promise<ConversationStoreData> => {
    const { value } = await readJsonFile(filePath, empty);
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

  const list = async (): Promise<MSTeamsConversationStoreEntry[]> => {
    const store = await readStore();
    return toConversationStoreEntries(Object.entries(store.conversations));
  };

  const get = async (conversationId: string): Promise<StoredConversationReference | null> => {
    const store = await readStore();
    return store.conversations[normalizeStoredConversationId(conversationId)] ?? null;
  };

  const findPreferredDmByUserId = async (
    id: string,
  ): Promise<MSTeamsConversationStoreEntry | null> => {
    return findPreferredDmConversationByUserId(await list(), id);
  };

  const upsert = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    await withFileLock(filePath, empty, async () => {
      const store = await readStore();
      store.conversations[normalizedId] = mergeStoredConversationReference(
        store.conversations[normalizedId],
        reference,
        new Date().toISOString(),
      );
      const nowMs = Date.now();
      store.conversations = pruneExpired(store.conversations, nowMs, ttlMs).conversations;
      store.conversations = pruneToLimit(store.conversations);
      await writeJsonFile(filePath, store);
    });
  };

  const remove = async (conversationId: string): Promise<boolean> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    return await withFileLock(filePath, empty, async () => {
      const store = await readStore();
      if (!(normalizedId in store.conversations)) {
        return false;
      }
      delete store.conversations[normalizedId];
      await writeJsonFile(filePath, store);
      return true;
    });
  };

  return {
    upsert,
    get,
    list,
    remove,
    findPreferredDmByUserId,
    findByUserId: findPreferredDmByUserId,
  };
}
