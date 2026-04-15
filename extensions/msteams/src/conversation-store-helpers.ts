import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type {
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";

export function normalizeStoredConversationId(raw: string): string {
  return raw.split(";")[0] ?? raw;
}

export function parseStoredConversationTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

export function toConversationStoreEntries(
  entries: Iterable<[string, StoredConversationReference]>,
): MSTeamsConversationStoreEntry[] {
  return Array.from(entries, ([conversationId, reference]) => ({
    conversationId,
    reference,
  }));
}

export function mergeStoredConversationReference(
  existing: StoredConversationReference | undefined,
  incoming: StoredConversationReference,
  nowIso: string,
): StoredConversationReference {
  return {
    // Preserve fields from the previous entry that may not be present on every
    // inbound activity. Without this, sparse activities (e.g. conversationUpdate,
    // reactions) would clear previously captured values. Some fields are only
    // populated opportunistically, such as timezone from clientInfo entities and
    // graphChatId from Graph lookups used for DM media downloads.
    ...(existing?.timezone && !incoming.timezone ? { timezone: existing.timezone } : {}),
    ...(existing?.graphChatId && !incoming.graphChatId
      ? { graphChatId: existing.graphChatId }
      : {}),
    ...(existing?.tenantId && !incoming.tenantId ? { tenantId: existing.tenantId } : {}),
    ...(existing?.aadObjectId && !incoming.aadObjectId
      ? { aadObjectId: existing.aadObjectId }
      : {}),
    ...incoming,
    lastSeenAt: nowIso,
  };
}

export function findPreferredDmConversationByUserId(
  entries: Iterable<MSTeamsConversationStoreEntry>,
  id: string,
): MSTeamsConversationStoreEntry | null {
  const target = id.trim();
  if (!target) {
    return null;
  }

  // Partition user matches into DM-safe and non-DM buckets.
  // Channel and group conversations also carry the sender's aadObjectId, but
  // returning one of those when the caller asked for a user-targeted DM would
  // leak the reply into a shared channel -- the root cause of #54520.
  const personalMatches: MSTeamsConversationStoreEntry[] = [];
  const unknownTypeMatches: MSTeamsConversationStoreEntry[] = [];
  for (const entry of entries) {
    if (entry.reference.user?.aadObjectId !== target && entry.reference.user?.id !== target) {
      continue;
    }
    const convType = normalizeLowercaseStringOrEmpty(
      entry.reference.conversation?.conversationType ?? "",
    );
    if (convType === "personal") {
      personalMatches.push(entry);
    } else if (convType === "channel" || convType === "groupchat") {
      // Explicitly skip channel/group conversations -- these must never be
      // returned for a user-targeted DM lookup.
    } else {
      // Legacy entries without conversationType are ambiguous. Include them
      // as a fallback but rank below confirmed personal conversations.
      unknownTypeMatches.push(entry);
    }
  }

  // Prefer confirmed personal DMs, fall back to unknown-type entries.
  const candidates = personalMatches.length > 0 ? personalMatches : unknownTypeMatches;
  if (candidates.length === 0) {
    return null;
  }

  // When multiple candidates exist, prefer the most recently seen one.
  if (candidates.length > 1) {
    candidates.sort(
      (a, b) =>
        (parseStoredConversationTimestamp(b.reference.lastSeenAt) ?? 0) -
        (parseStoredConversationTimestamp(a.reference.lastSeenAt) ?? 0),
    );
  }

  return candidates[0] ?? null;
}
