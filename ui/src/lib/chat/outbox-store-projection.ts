import { getSafeSessionStorage } from "../../local-storage.ts";
import { compareChatQueueOrder } from "./chat-queue-order.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import { outboxPayloadMatchesOwner } from "./outbox-payload-store.runtime.ts";
import type { StoredComposerSession } from "./outbox-store-codec.ts";
import {
  readProjectedOutboxStore,
  parseStoredChatOutboxScope,
  resolvePendingComposerSessions,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type StoredChatOutboxScope,
} from "./outbox-store.ts";

export { resolveStoredChatOutboxScope, storedChatOutboxScopeKey, subscribeStoredChatOutboxChanges };

export type StoredChatOutbox = StoredChatOutboxScope & { queue: ChatQueueItem[] };

function listStoredComposerRows(
  state: ChatComposerScope,
): Array<{ scope: StoredChatOutboxScope; session: StoredComposerSession }> {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return [];
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readProjectedOutboxStore(storage, target);
    if (resolvePendingComposerSessions(store, state)) {
      try {
        writeStoredOutboxStore(storage, target, store);
      } catch {
        // Readable pending records remain intact if quota blocks their transfer.
      }
    }
    return Object.entries(store.sessions).flatMap(([key, session]) => {
      const scope = parseStoredChatOutboxScope(key);
      return scope
        ? [
            {
              scope,
              session: {
                ...session,
                queue: session.queue?.filter((item) => outboxPayloadMatchesOwner(state, item)),
              },
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

export function listStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  return listStoredComposerRows(state)
    .flatMap(({ scope, session }) =>
      session.queue?.length
        ? [
            {
              ...scope,
              queue: session.queue.toSorted(compareChatQueueOrder),
            },
          ]
        : [],
    )
    .toSorted(
      (left, right) =>
        (left.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) -
          (right.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        left.sessionKey.localeCompare(right.sessionKey),
    );
}

export function summarizeStoredChatOutboxes(state: ChatComposerScope) {
  const idsByScope = new Map<string, { all: Set<string>; attention: Set<string> }>();
  const draftScopes = new Set<string>();
  for (const { scope, session } of listStoredComposerRows(state)) {
    const scopeKey = storedChatOutboxScopeKey(scope);
    if (session.draft) {
      draftScopes.add(scopeKey);
    }
    const ids = idsByScope.get(scopeKey) ?? {
      all: new Set<string>(),
      attention: new Set<string>(),
    };
    for (const item of session.queue ?? []) {
      if (!item.pendingRunId) {
        ids.all.add(item.id);
        if (item.sendState === "failed" || item.sendState === "unconfirmed") {
          ids.attention.add(item.id);
        }
      }
    }
    if (ids.all.size) {
      idsByScope.set(scopeKey, ids);
    }
  }
  const countsByScope = new Map<string, number>();
  const attentionCountsByScope = new Map<string, number>();
  let total = 0;
  for (const [scopeKey, ids] of idsByScope) {
    countsByScope.set(scopeKey, ids.all.size);
    total += ids.all.size;
    if (ids.attention.size) {
      attentionCountsByScope.set(scopeKey, ids.attention.size);
    }
  }
  return { countsByScope, attentionCountsByScope, draftScopes, total };
}
