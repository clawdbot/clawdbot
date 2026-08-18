import { getSafeSessionStorage } from "../../local-storage.ts";
import {
  resolveUiDefaultAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../sessions/session-key.ts";
import { compareChatQueueOrder } from "./chat-queue-order.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import type { StoredComposerSession } from "./outbox-store-codec.ts";
import {
  applyStoredChatOutboxScope,
  hasKnownSessionDefaults,
  readStoredOutboxStore,
  resolveComposerStorageScope,
  resolveStoredComposerSession,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  UNRESOLVED_GLOBAL_AGENT_SCOPE,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type ComposerStorageScope,
  type StoredChatOutboxScope,
} from "./outbox-store.ts";

export { resolveStoredChatOutboxScope, storedChatOutboxScopeKey, subscribeStoredChatOutboxChanges };

export type StoredChatOutbox = StoredChatOutboxScope & { queue: ChatQueueItem[] };

function listStoredComposerRows(
  state: ChatComposerScope,
): Array<{ scope: ComposerStorageScope; session: StoredComposerSession }> {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return [];
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStoredOutboxStore(storage, target);
    let migrated = false;
    const selectedAgentId = resolveUiKnownSelectedGlobalAgentId(state);
    const defaultAgentId = hasKnownSessionDefaults(state)
      ? resolveUiDefaultAgentId(state)
      : undefined;
    for (const agentId of new Set([defaultAgentId, selectedAgentId])) {
      if (agentId) {
        migrated =
          resolveStoredComposerSession(store, state, "global", agentId).migrated || migrated;
      }
    }
    const separator = "\u0000agent:";
    for (const storeSessionKey of Object.keys(store.sessions)) {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0) {
        continue;
      }
      const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
      const resolved = resolveStoredComposerSession(
        store,
        state,
        storeSessionKey.slice(0, separatorIndex),
        agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : agentScope,
      );
      migrated = resolved.migrated || migrated;
    }
    if (migrated) {
      try {
        writeStoredOutboxStore(storage, target, store);
      } catch {
        // A full storage bucket must not hide already-readable outboxes.
      }
    }
    return Object.entries(store.sessions).flatMap(([storeSessionKey, session]) => {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0) {
        return [];
      }
      const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
      return [
        {
          scope: resolveComposerStorageScope(
            state,
            storeSessionKey.slice(0, separatorIndex),
            agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : agentScope,
            store.mainAlias,
          ),
          session,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function listStoredDraftScopes(state: ChatComposerScope): ReadonlySet<string> {
  return new Set(
    listStoredComposerRows(state).flatMap(({ scope, session }) =>
      session.draft
        ? [
            storedChatOutboxScopeKey({
              sessionKey: scope.conversationKey,
              ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
            }),
          ]
        : [],
    ),
  );
}

export function listStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  return listStoredComposerRows(state)
    .flatMap(({ scope, session }) =>
      session.queue?.length
        ? [
            {
              sessionKey: scope.conversationKey,
              ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
              queue: session.queue
                .map((item) => applyStoredChatOutboxScope(item, scope))
                .toSorted(compareChatQueueOrder),
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
  for (const outbox of listStoredChatOutboxes(state)) {
    const ids = idsByScope.get(storedChatOutboxScopeKey(outbox)) ?? {
      all: new Set<string>(),
      attention: new Set<string>(),
    };
    for (const item of outbox.queue) {
      if (!item.pendingRunId) {
        ids.all.add(item.id);
        if (item.sendState === "failed" || item.sendState === "unconfirmed") {
          ids.attention.add(item.id);
        }
      }
    }
    if (ids.all.size) {
      idsByScope.set(storedChatOutboxScopeKey(outbox), ids);
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
  return { countsByScope, attentionCountsByScope, total };
}
