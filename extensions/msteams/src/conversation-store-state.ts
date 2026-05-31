import crypto from "node:crypto";
import fs from "node:fs/promises";
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
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile } from "./store-fs.js";

type ConversationStoreData = {
  version: 1;
  conversations: Record<string, StoredConversationReference>;
};

type ConversationMigrationMarker = {
  importedAt: string;
};

const STORE_FILENAME = "msteams-conversations.json";
const CONVERSATIONS_NAMESPACE = "conversations";
const CONVERSATION_MIGRATIONS_NAMESPACE = "conversation-migrations";
const LEGACY_JSON_MIGRATION_KEY = "msteams-conversations-json-v1";
const MAX_CONVERSATIONS = 1000;
const SQLITE_MAX_CONVERSATION_ROWS = MAX_CONVERSATIONS + 1000;
const CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const CONVERSATION_LOCK_FILENAME = "msteams-conversations.sqlite.lock";

type MSTeamsConversationStoreStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  ttlMs?: number;
  stateDir?: string;
  storePath?: string;
};

function createConversationStateStore(params?: MSTeamsConversationStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<StoredConversationReference>({
    namespace: CONVERSATIONS_NAMESPACE,
    maxEntries: SQLITE_MAX_CONVERSATION_ROWS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function createConversationMigrationStore(params?: MSTeamsConversationStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<ConversationMigrationMarker>({
    namespace: CONVERSATION_MIGRATIONS_NAMESPACE,
    maxEntries: 100,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function resolveLegacyStorePath(params?: MSTeamsConversationStoreStateOptions): string {
  return resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });
}

function normalizeLegacyStore(value: ConversationStoreData): ConversationStoreData {
  if (
    value.version !== 1 ||
    !value.conversations ||
    typeof value.conversations !== "object" ||
    Array.isArray(value.conversations)
  ) {
    return { version: 1, conversations: {} };
  }
  return value;
}

function buildConversationStateKey(conversationId: string): string {
  return crypto.createHash("sha256").update(conversationId).digest("hex");
}

function prepareConversationReferenceForStorage(
  conversationId: string,
  reference: StoredConversationReference,
): StoredConversationReference {
  return {
    ...reference,
    conversation: {
      ...reference.conversation,
      id: conversationId,
    },
  };
}

function getStoredConversationId(reference: StoredConversationReference): string | null {
  const rawId = reference.conversation?.id;
  return rawId ? normalizeStoredConversationId(rawId) : null;
}

export function createMSTeamsConversationStoreState(
  params?: MSTeamsConversationStoreStateOptions,
): MSTeamsConversationStore {
  const ttlMs = params?.ttlMs ?? CONVERSATION_TTL_MS;
  const conversationStore = createConversationStateStore(params);
  const migrationStore = createConversationMigrationStore(params);
  const legacyStorePath = resolveLegacyStorePath(params);
  let legacyImportPromise: Promise<void> | null = null;

  const isExpired = (reference: StoredConversationReference): boolean => {
    const lastSeenAt = parseStoredConversationTimestamp(reference.lastSeenAt);
    // Preserve migrated legacy entries that have no lastSeenAt until they're seen again.
    return lastSeenAt != null && Date.now() - lastSeenAt > ttlMs;
  };

  const selectRetainedConversations = (
    conversations: Record<string, StoredConversationReference>,
  ): Array<[string, StoredConversationReference]> => {
    const retained = Object.entries(conversations).filter(([, reference]) => !isExpired(reference));
    if (retained.length <= MAX_CONVERSATIONS) {
      return retained;
    }
    retained.sort((a, b) => {
      const aTs = parseStoredConversationTimestamp(a[1].lastSeenAt) ?? 0;
      const bTs = parseStoredConversationTimestamp(b[1].lastSeenAt) ?? 0;
      return aTs - bTs || a[0].localeCompare(b[0]);
    });
    return retained.slice(retained.length - MAX_CONVERSATIONS);
  };

  const importLegacyStore = async (): Promise<void> => {
    if (await migrationStore.lookup(LEGACY_JSON_MIGRATION_KEY)) {
      return;
    }
    const empty: ConversationStoreData = { version: 1, conversations: {} };
    const { value, exists } = await readJsonFile<ConversationStoreData>(legacyStorePath, empty);
    if (!exists) {
      await migrationStore.register(LEGACY_JSON_MIGRATION_KEY, {
        importedAt: new Date().toISOString(),
      });
      return;
    }
    const legacy = normalizeLegacyStore(value);
    for (const [rawConversationId, reference] of selectRetainedConversations(
      legacy.conversations,
    )) {
      const conversationId = normalizeStoredConversationId(rawConversationId);
      if (!conversationId) {
        continue;
      }
      await conversationStore.registerIfAbsent(
        buildConversationStateKey(conversationId),
        toPluginJsonValue(prepareConversationReferenceForStorage(conversationId, reference)),
      );
    }
    await migrationStore.register(LEGACY_JSON_MIGRATION_KEY, {
      importedAt: new Date().toISOString(),
    });
    await fs.rm(legacyStorePath, { force: true }).catch(() => {});
  };

  const ensureLegacyImported = async (): Promise<void> => {
    legacyImportPromise ??= withMSTeamsSqliteMutationLock(
      params,
      CONVERSATION_LOCK_FILENAME,
      importLegacyStore,
    );
    await legacyImportPromise;
  };

  const lookupStored = async (
    conversationId: string,
  ): Promise<StoredConversationReference | null> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    const value = await conversationStore.lookup(buildConversationStateKey(normalizedId));
    if (!value) {
      return null;
    }
    if (isExpired(value)) {
      return null;
    }
    return value;
  };

  const entries = async (): Promise<Array<[string, StoredConversationReference]>> => {
    await ensureLegacyImported();
    const rows = await conversationStore.entries();
    const kept: Array<[string, StoredConversationReference]> = [];
    for (const row of rows) {
      if (isExpired(row.value)) {
        continue;
      }
      const conversationId = getStoredConversationId(row.value);
      if (conversationId) {
        kept.push([conversationId, row.value]);
      }
    }
    return kept;
  };

  const lookup = async (conversationId: string): Promise<StoredConversationReference | null> => {
    await ensureLegacyImported();
    return await lookupStored(conversationId);
  };

  const register = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    await conversationStore.register(
      buildConversationStateKey(normalizedId),
      toPluginJsonValue(prepareConversationReferenceForStorage(normalizedId, reference)),
    );
    const rows = [];
    for (const row of await conversationStore.entries()) {
      if (isExpired(row.value)) {
        await conversationStore.delete(row.key);
        continue;
      }
      rows.push(row);
    }
    if (rows.length <= MAX_CONVERSATIONS) {
      return;
    }
    const sorted = rows.toSorted((a, b) => {
      const aTs = parseStoredConversationTimestamp(a.value.lastSeenAt) ?? 0;
      const bTs = parseStoredConversationTimestamp(b.value.lastSeenAt) ?? 0;
      const aId = getStoredConversationId(a.value) ?? a.key;
      const bId = getStoredConversationId(b.value) ?? b.key;
      return aTs - bTs || aId.localeCompare(bId);
    });
    for (const row of sorted.slice(0, rows.length - MAX_CONVERSATIONS)) {
      await conversationStore.delete(row.key);
    }
  };

  const list = async (): Promise<MSTeamsConversationStoreEntry[]> => {
    return toConversationStoreEntries(await entries());
  };

  const get = async (conversationId: string): Promise<StoredConversationReference | null> => {
    return await lookup(conversationId);
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
    await withMSTeamsSqliteMutationLock(params, CONVERSATION_LOCK_FILENAME, async () => {
      await importLegacyStore();
      const existing = await lookupStored(normalizedId);
      await register(
        normalizedId,
        mergeStoredConversationReference(
          existing ?? undefined,
          reference,
          new Date().toISOString(),
        ),
      );
    });
  };

  const remove = async (conversationId: string): Promise<boolean> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    return await withMSTeamsSqliteMutationLock(params, CONVERSATION_LOCK_FILENAME, async () => {
      await importLegacyStore();
      return await conversationStore.delete(buildConversationStateKey(normalizedId));
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
