import {
  findPreferredDmConversationByUserId,
  mergeStoredConversationReference,
  normalizeStoredConversationId,
  toConversationStoreEntries,
} from "./conversation-store-helpers.js";
import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";

export function createMSTeamsConversationStoreMemory(
  initial: MSTeamsConversationStoreEntry[] = [],
): MSTeamsConversationStore {
  const map = new Map<string, StoredConversationReference>();
  for (const { conversationId, reference } of initial) {
    map.set(normalizeStoredConversationId(conversationId), reference);
  }

  const findPreferredDmByUserId = async (
    id: string,
  ): Promise<MSTeamsConversationStoreEntry | null> => {
    return findPreferredDmConversationByUserId(toConversationStoreEntries(map.entries()), id);
  };

  return {
    upsert: async (conversationId, reference) => {
      const normalizedId = normalizeStoredConversationId(conversationId);
      map.set(
        normalizedId,
        mergeStoredConversationReference(
          map.get(normalizedId),
          reference,
          new Date().toISOString(),
        ),
      );
    },
    get: async (conversationId) => {
      return map.get(normalizeStoredConversationId(conversationId)) ?? null;
    },
    list: async () => {
      return toConversationStoreEntries(map.entries());
    },
    remove: async (conversationId) => {
      return map.delete(normalizeStoredConversationId(conversationId));
    },
    findPreferredDmByUserId,
    findByUserId: findPreferredDmByUserId,
  };
}
