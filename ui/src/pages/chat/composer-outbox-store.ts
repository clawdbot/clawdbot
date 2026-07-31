import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  MAX_RETAINED_QUEUE_ITEMS,
  MAX_STORED_SESSIONS,
  normalizeStoredSession,
  type StoredComposerSession,
} from "../../lib/chat/outbox-store-codec.ts";
import {
  rememberStoredMainAlias,
  resolveComposerStorageScope,
  storageTargetForGateway,
  UNRESOLVED_GLOBAL_AGENT_SCOPE,
  type ChatComposerScope,
  type ComposerStorageScope,
  type ComposerStorageTarget,
  type StoredChatOutboxScope,
  type StoredComposerMainAlias,
} from "../../lib/chat/outbox-store.ts";
import {
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";

export {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  MAX_STORED_QUEUE_ITEMS,
  normalizeOptionalString,
  normalizeSkillWorkshopRevision,
  normalizeStoredSession,
} from "../../lib/chat/outbox-store-codec.ts";
export type { StoredComposerSession } from "../../lib/chat/outbox-store-codec.ts";

export type StoredComposerState = {
  version: 2;
  gatewayOwner: string;
  sessions: Record<string, StoredComposerSession>;
  mainAlias?: StoredComposerMainAlias;
};

export type StoredChatOutbox = StoredChatOutboxScope & {
  queue: ChatQueueItem[];
};

function hasKnownSessionDefaults(state: ChatComposerScope): boolean {
  if (state.agentsList !== null && state.agentsList !== undefined) {
    return true;
  }
  const snapshot = state.hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !("sessionDefaults" in snapshot)) {
    return false;
  }
  return Boolean(snapshot.sessionDefaults && typeof snapshot.sessionDefaults === "object");
}

function updateStoredMainAlias(store: StoredComposerState, state: ChatComposerScope): boolean {
  if (!hasKnownSessionDefaults(state)) {
    return false;
  }
  const key = resolveUiConfiguredMainKey(state);
  if (key === DEFAULT_MAIN_KEY) {
    if (!store.mainAlias) {
      return false;
    }
    delete store.mainAlias;
    return true;
  }
  const next = { key, agentId: resolveUiDefaultAgentId(state) };
  if (store.mainAlias?.key === next.key && store.mainAlias.agentId === next.agentId) {
    return false;
  }
  store.mainAlias = next;
  return true;
}

function storageSessionKeyForAgentScope(sessionKey: string, agentScope: string): string {
  return `${sessionKey}\u0000agent:${agentScope}`;
}
function mergeStoredComposerSessions(
  current: StoredComposerSession | null,
  incoming: StoredComposerSession,
): StoredComposerSession {
  if (!current) {
    return incoming;
  }
  // Incoming rows are visited in storage insertion order, so they win a
  // millisecond timestamp tie instead of letting an older canonical row mask a
  // just-written alias or unresolved draft.
  const newest = current.updatedAt > incoming.updatedAt ? current : incoming;
  const older = newest === current ? incoming : current;
  const currentDraftRevision = current.draftRevision;
  const incomingDraftRevision = incoming.draftRevision;
  const newestDraftOwner =
    currentDraftRevision === undefined
      ? incomingDraftRevision === undefined
        ? null
        : incoming
      : incomingDraftRevision === undefined
        ? current
        : currentDraftRevision > incomingDraftRevision
          ? current
          : incoming;
  const queueById = new Map(
    [...(older.queue ?? []), ...(newest.queue ?? [])].map((item) => [item.id, item]),
  );
  const queue = Array.from(queueById.values())
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .slice(0, MAX_RETAINED_QUEUE_ITEMS);
  return {
    ...(newestDraftOwner?.draft ? { draft: newestDraftOwner.draft } : {}),
    ...(newestDraftOwner?.draftRevision !== undefined
      ? { draftRevision: newestDraftOwner.draftRevision }
      : {}),
    ...(queue.length ? { queue } : {}),
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
}

export function resolveStoredComposerSession(
  store: StoredComposerState,
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): { session: StoredComposerSession | null; storeSessionKey: string; migrated: boolean } {
  let migrated = updateStoredMainAlias(store, state);
  const scope = resolveComposerStorageScope(state, sessionKey, agentIdOverride, store.mainAlias);
  const storeSessionKey = storageSessionKeyForAgentScope(scope.conversationKey, scope.agentScope);
  const configuredMainKey = resolveUiConfiguredMainKey(state);
  const defaultGlobalAgentId = hasKnownSessionDefaults(state)
    ? resolveUiDefaultAgentId(state)
    : undefined;
  if (defaultGlobalAgentId) {
    const defaultGlobalKey = storageSessionKeyForAgentScope("global", defaultGlobalAgentId);
    let defaultGlobalSession = normalizeStoredSession(store.sessions[defaultGlobalKey]);
    const bareMainAliases = new Set([DEFAULT_MAIN_KEY, configuredMainKey]);
    const agentSeparator = "\u0000agent:";
    for (const legacySessionKey of Object.keys(store.sessions)) {
      if (legacySessionKey === defaultGlobalKey) {
        continue;
      }
      const separatorIndex = legacySessionKey.lastIndexOf(agentSeparator);
      if (separatorIndex < 0) {
        continue;
      }
      const legacyRawSessionKey = legacySessionKey.slice(0, separatorIndex).trim().toLowerCase();
      if (!bareMainAliases.has(legacyRawSessionKey)) {
        continue;
      }
      const legacySession = normalizeStoredSession(store.sessions[legacySessionKey]);
      if (!legacySession) {
        continue;
      }
      // Shipped v1 scoped every unparsed bare route to the selected agent.
      // Bare main aliases are default-agent routes; qualified agent routes
      // keep their explicit owner because their raw key cannot match here.
      const migratedQueue = legacySession.queue?.map((item) => ({
        ...item,
        agentId: defaultGlobalAgentId,
        sessionKey: "global",
      }));
      defaultGlobalSession = mergeStoredComposerSessions(defaultGlobalSession, {
        ...legacySession,
        ...(migratedQueue ? { queue: migratedQueue } : {}),
      });
      store.sessions[defaultGlobalKey] = defaultGlobalSession;
      delete store.sessions[legacySessionKey];
      migrated = true;
    }
  }
  let session = normalizeStoredSession(store.sessions[storeSessionKey]);
  if (!scope.isGlobal && !parseAgentSessionKey(sessionKey)) {
    const legacyPrefix = `${scope.conversationKey}\u0000agent:`;
    for (const legacySessionKey of Object.keys(store.sessions)) {
      if (legacySessionKey === storeSessionKey || !legacySessionKey.startsWith(legacyPrefix)) {
        continue;
      }
      const legacySession = normalizeStoredSession(store.sessions[legacySessionKey]);
      if (!legacySession) {
        continue;
      }
      // Shipped v1 assigned every unparsed route to the selected agent. Merge
      // exact raw-route rows into the agentless key before mutation, or queued
      // input can be listed but never updated or removed.
      const migratedQueue = legacySession.queue?.map(({ agentId: _agentId, ...item }) => ({
        ...item,
        sessionKey: scope.conversationKey,
      }));
      session = mergeStoredComposerSessions(session, {
        ...legacySession,
        ...(migratedQueue ? { queue: migratedQueue } : {}),
      });
      store.sessions[storeSessionKey] = session;
      delete store.sessions[legacySessionKey];
      migrated = true;
    }
  }
  const agentSuffix = `\u0000agent:${scope.agentScope}`;
  for (const legacySessionKey of Object.keys(store.sessions)) {
    if (legacySessionKey === storeSessionKey || !legacySessionKey.endsWith(agentSuffix)) {
      continue;
    }
    const legacyRawSessionKey = legacySessionKey.slice(0, -agentSuffix.length);
    const legacyScope = resolveComposerStorageScope(
      state,
      legacyRawSessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
      store.mainAlias,
    );
    if (legacyScope.conversationKey !== scope.conversationKey) {
      continue;
    }
    const legacySession = normalizeStoredSession(store.sessions[legacySessionKey]);
    if (legacySession) {
      // Shipped qualified-main rows retain their alias in each queue item.
      // Canonicalize those embedded routes with the row, or replay mutations
      // cannot match the restored global item against durable storage.
      const migratedQueue = legacySession.queue?.map(({ agentId: _agentId, ...item }) => ({
        ...item,
        sessionKey: scope.conversationKey,
        ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
      }));
      session = mergeStoredComposerSessions(session, {
        ...legacySession,
        ...(migratedQueue ? { queue: migratedQueue } : {}),
      });
      store.sessions[storeSessionKey] = session;
      delete store.sessions[legacySessionKey];
      migrated = true;
    }
  }
  if (!scope.isGlobal) {
    return { session, storeSessionKey, migrated };
  }
  const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  if (!selectedGlobalAgentId || scope.agentScope !== selectedGlobalAgentId) {
    return { session, storeSessionKey, migrated };
  }
  const unresolvedKey = storageSessionKeyForAgentScope(
    scope.conversationKey,
    UNRESOLVED_GLOBAL_AGENT_SCOPE,
  );
  if (storeSessionKey === unresolvedKey) {
    return { session, storeSessionKey, migrated };
  }
  const unresolved = normalizeStoredSession(store.sessions[unresolvedKey]);
  if (!unresolved) {
    return { session, storeSessionKey, migrated };
  }
  const resolvedUnscopedQueue = unresolved.queue?.map((item) =>
    item.agentId ? item : { ...item, agentId: scope.agentScope },
  );
  const merged = mergeStoredComposerSessions(session, {
    ...unresolved,
    ...(resolvedUnscopedQueue ? { queue: resolvedUnscopedQueue } : {}),
  });
  store.sessions[storeSessionKey] = merged;
  delete store.sessions[unresolvedKey];
  return { session: merged, storeSessionKey, migrated: true };
}

function parseStore(
  storage: Storage,
  target: ComposerStorageTarget,
  raw: string,
  version: 1 | 2,
): StoredComposerState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredComposerState>;
    if (
      !parsed ||
      parsed.version !== version ||
      (version === 2 && parsed.gatewayOwner !== target.gatewayOwner) ||
      !parsed.sessions ||
      typeof parsed.sessions !== "object"
    ) {
      return null;
    }
    const sessions: Record<string, StoredComposerSession> = {};
    for (const [sessionKey, value] of Object.entries(parsed.sessions)) {
      const session = normalizeStoredSession(value);
      if (session) {
        sessions[sessionKey] = session;
      }
    }
    const rawMainAlias = parsed.mainAlias;
    const mainAlias =
      rawMainAlias &&
      typeof rawMainAlias === "object" &&
      "key" in rawMainAlias &&
      typeof rawMainAlias.key === "string" &&
      rawMainAlias.key.trim() &&
      "agentId" in rawMainAlias &&
      typeof rawMainAlias.agentId === "string" &&
      rawMainAlias.agentId.trim()
        ? {
            key: rawMainAlias.key.trim().toLowerCase(),
            agentId: normalizeAgentId(rawMainAlias.agentId),
          }
        : undefined;
    rememberStoredMainAlias(storage, target.key, mainAlias);
    return {
      version: 2,
      gatewayOwner: target.gatewayOwner,
      sessions,
      ...(mainAlias ? { mainAlias } : {}),
    };
  } catch {
    return null;
  }
}

export function readStoredOutboxStore(
  storage: Storage,
  target: ComposerStorageTarget,
): StoredComposerState {
  const raw = storage.getItem(target.key);
  if (raw) {
    const store = parseStore(storage, target, raw, 2);
    if (store) {
      return store;
    }
    rememberStoredMainAlias(storage, target.key, undefined);
    return { version: 2, gatewayOwner: target.gatewayOwner, sessions: {} };
  }
  if (target.legacyOwnerIsUnambiguous) {
    const legacyRaw = storage.getItem(target.legacyKey);
    if (legacyRaw) {
      const store = parseStore(storage, target, legacyRaw, 1);
      if (store) {
        try {
          writeStoredOutboxStore(storage, target, store);
          storage.removeItem(target.legacyKey);
        } catch {
          // Keep the readable v1 row when quota or privacy mode blocks migration.
        }
        return store;
      }
    }
  }
  rememberStoredMainAlias(storage, target.key, undefined);
  return { version: 2, gatewayOwner: target.gatewayOwner, sessions: {} };
}

export function writeStoredOutboxStore(
  storage: Storage,
  target: ComposerStorageTarget,
  store: StoredComposerState,
): void {
  const entries = Object.entries(store.sessions);
  const outboxes = entries.filter(([, session]) => session.queue?.length);
  if (outboxes.length > MAX_STORED_SESSIONS) {
    throw new Error("Chat outbox session limit reached");
  }
  const drafts = entries.filter(([, session]) => !session.queue?.length);
  const unresolvedGlobalKey = `global\u0000agent:${UNRESOLVED_GLOBAL_AGENT_SCOPE}`;
  const unresolvedGlobalDraft = drafts.find(([sessionKey]) => sessionKey === unresolvedGlobalKey);
  const byNewest = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    b[1].updatedAt - a[1].updatedAt ||
    (b[1].draftRevision ?? 0) - (a[1].draftRevision ?? 0) ||
    a[0].localeCompare(b[0]);
  const clearFences = drafts
    .filter(
      ([sessionKey, session]) =>
        sessionKey !== unresolvedGlobalKey && !session.draft && session.draftRevision !== undefined,
    )
    .toSorted(byNewest);
  // Unknown custom main aliases cannot be identified until defaults reload.
  // Keep a bounded set of their clear fences, plus the canonical unresolved
  // row, so eviction cannot reveal an older resolved-agent draft.
  const protectedDrafts = [
    ...(unresolvedGlobalDraft ? [unresolvedGlobalDraft] : []),
    ...clearFences,
  ].slice(0, MAX_STORED_SESSIONS);
  const ordinaryDrafts = drafts.filter(
    ([sessionKey, session]) => sessionKey !== unresolvedGlobalKey && Boolean(session.draft),
  );
  const regularSessions = [
    ...outboxes.toSorted(byNewest),
    ...ordinaryDrafts.toSorted(byNewest),
  ].slice(0, MAX_STORED_SESSIONS);
  const retained = [...regularSessions, ...protectedDrafts];
  if (retained.length === 0 && !store.mainAlias) {
    storage.removeItem(target.key);
    rememberStoredMainAlias(storage, target.key, undefined);
    return;
  }
  storage.setItem(
    target.key,
    JSON.stringify({
      version: 2,
      gatewayOwner: target.gatewayOwner,
      sessions: Object.fromEntries(retained),
      ...(store.mainAlias ? { mainAlias: store.mainAlias } : {}),
    }),
  );
  rememberStoredMainAlias(storage, target.key, store.mainAlias);
}

export function applyStoredChatOutboxScope(
  item: ChatQueueItem,
  scope: ComposerStorageScope,
): ChatQueueItem {
  const { agentId: _agentId, ...withoutAgentId } = item;
  return {
    ...withoutAgentId,
    sessionKey: scope.conversationKey,
    ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
  };
}

export function listStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return [];
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStoredOutboxStore(storage, target);
    const separator = "\u0000agent:";
    let migrated = false;
    const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
    const defaultGlobalAgentId = hasKnownSessionDefaults(state)
      ? resolveUiDefaultAgentId(state)
      : undefined;
    if (defaultGlobalAgentId) {
      const resolved = resolveStoredComposerSession(store, state, "global", defaultGlobalAgentId);
      migrated = resolved.migrated;
    }
    if (selectedGlobalAgentId) {
      const resolved = resolveStoredComposerSession(store, state, "global", selectedGlobalAgentId);
      migrated = resolved.migrated || migrated;
    }
    for (const storeSessionKey of Object.keys(store.sessions)) {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0) {
        continue;
      }
      const sessionKey = storeSessionKey.slice(0, separatorIndex);
      const storedAgentScope = storeSessionKey.slice(separatorIndex + separator.length);
      const resolved = resolveStoredComposerSession(
        store,
        state,
        sessionKey,
        storedAgentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : storedAgentScope,
      );
      migrated = resolved.migrated || migrated;
    }
    if (migrated) {
      try {
        writeStoredOutboxStore(storage, target, store);
      } catch {
        // A full storage bucket must not make already-readable outboxes disappear.
      }
    }
    const outboxes: StoredChatOutbox[] = [];
    for (const [storeSessionKey, value] of Object.entries(store.sessions)) {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0) {
        continue;
      }
      const sessionKey = storeSessionKey.slice(0, separatorIndex);
      const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
      const session = normalizeStoredSession(value);
      if (!session?.queue?.length) {
        continue;
      }
      const scope = resolveComposerStorageScope(
        state,
        sessionKey,
        agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : agentScope,
        store.mainAlias,
      );
      outboxes.push({
        sessionKey: scope.conversationKey,
        ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
        queue: session.queue.map((item) => applyStoredChatOutboxScope(item, scope)),
      });
    }
    return outboxes.toSorted((left, right) => {
      const createdAtDelta =
        (left.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) -
        (right.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER);
      return createdAtDelta || left.sessionKey.localeCompare(right.sessionKey);
    });
  } catch {
    return [];
  }
}
