import { getSafeSessionStorage } from "../../local-storage.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../sessions/session-key.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import {
  MAX_RETAINED_QUEUE_ITEMS,
  MAX_STORED_SESSIONS,
  normalizeStoredSession,
  type StoredComposerSession,
} from "./outbox-store-codec.ts";
import { observeDraftRevision, rememberDraftRevision } from "./outbox-store-draft-state.ts";

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v2:";
export const UNRESOLVED_GLOBAL_AGENT_SCOPE = "@unresolved";
const storedChatOutboxChangeListeners = new Set<() => void>();
let storageChangeListenerInstalled = false;

export type ChatComposerScope = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

export type StoredComposerMainAlias = {
  key: string;
  agentId: string;
};

export type ComposerStorageTarget = {
  key: string;
  legacyKey: string;
  gatewayOwner: string;
  legacyOwnerIsUnambiguous: boolean;
};

export type ComposerStorageScope = {
  conversationKey: string;
  agentScope: string;
  routingAgentId?: string;
  isGlobal: boolean;
};

export type StoredChatOutboxScope = {
  sessionKey: string;
  agentId?: string;
};

export type StoredComposerState = {
  version: 2;
  gatewayOwner: string;
  sessions: Record<string, StoredComposerSession>;
  mainAlias?: StoredComposerMainAlias;
};

export type StoredChatOutbox = StoredChatOutboxScope & {
  queue: ChatQueueItem[];
};

type StoredChatOutboxSummary = {
  countsByScope: ReadonlyMap<string, number>;
  total: number;
};

const storedMainAliasByStorage = new WeakMap<
  Storage,
  Map<string, StoredComposerMainAlias | null>
>();

export function subscribeStoredChatOutboxChanges(listener: () => void): () => void {
  storedChatOutboxChangeListeners.add(listener);
  if (!storageChangeListenerInstalled && typeof window !== "undefined") {
    storageChangeListenerInstalled = true;
    window.addEventListener("storage", handleStoredChatOutboxStorageChange);
  }
  return () => {
    storedChatOutboxChangeListeners.delete(listener);
    if (
      storageChangeListenerInstalled &&
      storedChatOutboxChangeListeners.size === 0 &&
      typeof window !== "undefined"
    ) {
      storageChangeListenerInstalled = false;
      window.removeEventListener("storage", handleStoredChatOutboxStorageChange);
    }
  };
}

export function notifyStoredChatOutboxChanges(): void {
  for (const listener of storedChatOutboxChangeListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[openclaw] stored chat outbox listener failed", error);
    }
  }
}

function handleStoredChatOutboxStorageChange(event: StorageEvent): void {
  if (
    event.key?.startsWith(STORAGE_KEY_PREFIX) ||
    event.key?.startsWith(LEGACY_STORAGE_KEY_PREFIX)
  ) {
    notifyStoredChatOutboxChanges();
  }
}

export function storageTargetForGateway(
  gatewayUrl: string | null | undefined,
): ComposerStorageTarget {
  const gatewayOwner = gatewayUrl?.trim() || "default";
  const encodedOwner = encodeURIComponent(gatewayOwner);
  return {
    key: `${STORAGE_KEY_PREFIX}${encodedOwner}`,
    legacyKey: `${LEGACY_STORAGE_KEY_PREFIX}${encodedOwner.slice(0, 240)}`,
    gatewayOwner,
    // Shipped v1 keys omitted the owner and truncated its encoded value. A
    // truncated row cannot prove which same-prefix gateway owns its outbox.
    legacyOwnerIsUnambiguous: encodedOwner.length < 240,
  };
}

function hasKnownSessionDefaults(state: ChatComposerScope): boolean {
  if (state.agentsList != null) {
    return true;
  }
  const snapshot = state.hello?.snapshot;
  return Boolean(
    snapshot &&
    typeof snapshot === "object" &&
    "sessionDefaults" in snapshot &&
    snapshot.sessionDefaults &&
    typeof snapshot.sessionDefaults === "object",
  );
}

function rememberStoredMainAlias(
  storage: Storage,
  storageKey: string,
  mainAlias: StoredComposerMainAlias | undefined,
) {
  let byStorageKey = storedMainAliasByStorage.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    storedMainAliasByStorage.set(storage, byStorageKey);
  }
  byStorageKey.set(storageKey, mainAlias ?? null);
}

function rememberedStoredMainAlias(
  storage: Storage,
  storageKey: string,
): StoredComposerMainAlias | undefined {
  return storedMainAliasByStorage.get(storage)?.get(storageKey) ?? undefined;
}

export function resolveComposerStorageScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
  storedMainAlias?: StoredComposerMainAlias,
): ComposerStorageScope {
  const parsed = parseAgentSessionKey(sessionKey);
  const normalizedSessionKey = sessionKey.trim().toLowerCase();
  const knownSessionDefaults = hasKnownSessionDefaults(state);
  const configuredMainKey = resolveUiConfiguredMainKey(state);
  const bareGlobalAlias =
    normalizedSessionKey === DEFAULT_MAIN_KEY || normalizedSessionKey === configuredMainKey;
  const storedAliasCandidate = parsed?.rest ?? normalizedSessionKey;
  const storedMainAliasMatches =
    !knownSessionDefaults && storedMainAlias?.key === storedAliasCandidate;
  const storedBareMainAliasAgentId =
    !knownSessionDefaults &&
    !parsed &&
    storedMainAlias &&
    (normalizedSessionKey === DEFAULT_MAIN_KEY || storedMainAliasMatches)
      ? storedMainAlias.agentId
      : undefined;
  const unresolvedBareMain =
    !knownSessionDefaults && !parsed && normalizedSessionKey === DEFAULT_MAIN_KEY;
  const parsedGlobalAlias =
    parsed &&
    (parsed.rest === "global" ||
      parsed.rest === DEFAULT_MAIN_KEY ||
      parsed.rest === configuredMainKey);
  const isGlobal =
    normalizedSessionKey === "global" ||
    bareGlobalAlias ||
    Boolean(parsedGlobalAlias) ||
    storedMainAliasMatches;
  const explicitAgentId = parsed?.agentId ?? agentIdOverride?.trim();
  const knownAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  const bareGlobalAgentId =
    knownSessionDefaults && !parsed && bareGlobalAlias ? resolveUiDefaultAgentId(state) : undefined;
  const routingAgentId = isGlobal
    ? explicitAgentId
      ? normalizeAgentId(explicitAgentId)
      : bareGlobalAgentId
        ? bareGlobalAgentId
        : storedBareMainAliasAgentId
          ? storedBareMainAliasAgentId
          : unresolvedBareMain
            ? undefined
            : knownAgentId
              ? knownAgentId
              : storedMainAliasMatches
                ? storedMainAlias.agentId
                : undefined
    : parsed?.agentId
      ? normalizeAgentId(parsed.agentId)
      : undefined;
  const agentScope =
    routingAgentId ?? (isGlobal ? UNRESOLVED_GLOBAL_AGENT_SCOPE : DEFAULT_AGENT_ID);
  // Before Gateway defaults load, bare `main` means the unknown default agent
  // while raw `global` means the unknown selected agent. Keep their durable
  // rows distinct until those two owners can be resolved.
  const preserveBareMainRoute = unresolvedBareMain && !routingAgentId;
  return {
    conversationKey: preserveBareMainRoute ? DEFAULT_MAIN_KEY : isGlobal ? "global" : sessionKey,
    agentScope,
    ...(routingAgentId ? { routingAgentId } : {}),
    isGlobal,
  };
}

function storageSessionKeyForAgentScope(sessionKey: string, agentScope: string): string {
  return `${sessionKey}\u0000agent:${agentScope}`;
}

function updateStoredMainAlias(store: StoredComposerState, state: ChatComposerScope): boolean {
  if (!hasKnownSessionDefaults(state)) {
    return false;
  }
  const key = resolveUiConfiguredMainKey(state);
  const next =
    key === DEFAULT_MAIN_KEY ? undefined : { key, agentId: resolveUiDefaultAgentId(state) };
  if (store.mainAlias?.key === next?.key && store.mainAlias?.agentId === next?.agentId) {
    return false;
  }
  if (next) {
    store.mainAlias = next;
  } else {
    delete store.mainAlias;
  }
  return true;
}

function mergeStoredComposerSessions(
  current: StoredComposerSession | null,
  incoming: StoredComposerSession,
): StoredComposerSession {
  if (!current) {
    return incoming;
  }
  // Storage insertion order breaks timestamp ties, while draft revisions remain
  // independent so a newer queue update cannot erase an older live draft.
  const newest = current.updatedAt > incoming.updatedAt ? current : incoming;
  const older = newest === current ? incoming : current;
  const draftOwner =
    (current.draftRevision ?? -1) > (incoming.draftRevision ?? -1) ? current : incoming;
  const queue = Array.from(
    new Map(
      [...(older.queue ?? []), ...(newest.queue ?? [])].map((item) => [item.id, item]),
    ).values(),
  )
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .slice(0, MAX_RETAINED_QUEUE_ITEMS);
  return {
    ...(draftOwner.draft ? { draft: draftOwner.draft } : {}),
    ...(draftOwner.draftRevision !== undefined ? { draftRevision: draftOwner.draftRevision } : {}),
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
  const defaultGlobalAgentId = hasKnownSessionDefaults(state)
    ? resolveUiDefaultAgentId(state)
    : store.mainAlias?.agentId;
  if (defaultGlobalAgentId) {
    const defaultGlobalKey = storageSessionKeyForAgentScope("global", defaultGlobalAgentId);
    let defaultGlobalSession = normalizeStoredSession(store.sessions[defaultGlobalKey]);
    const bareMainAliases = new Set([
      DEFAULT_MAIN_KEY,
      resolveUiConfiguredMainKey(state),
      ...(store.mainAlias ? [store.mainAlias.key] : []),
    ]);
    for (const legacySessionKey of Object.keys(store.sessions)) {
      if (legacySessionKey === defaultGlobalKey) {
        continue;
      }
      const separatorIndex = legacySessionKey.lastIndexOf("\u0000agent:");
      if (
        separatorIndex < 0 ||
        !bareMainAliases.has(legacySessionKey.slice(0, separatorIndex).trim().toLowerCase())
      ) {
        continue;
      }
      const legacySession = normalizeStoredSession(store.sessions[legacySessionKey]);
      if (!legacySession) {
        continue;
      }
      // Shipped bare-main rows kept the selected agent, but the route always
      // belongs to the default agent; preserve every queued item while moving it.
      const queue = legacySession.queue?.map((item) => ({
        ...item,
        agentId: defaultGlobalAgentId,
        sessionKey: "global",
      }));
      defaultGlobalSession = mergeStoredComposerSessions(defaultGlobalSession, {
        ...legacySession,
        ...(queue ? { queue } : {}),
      });
      store.sessions[defaultGlobalKey] = defaultGlobalSession;
      delete store.sessions[legacySessionKey];
      migrated = true;
    }
  }
  let session = normalizeStoredSession(store.sessions[storeSessionKey]);
  const agentSuffix = `\u0000agent:${scope.agentScope}`;
  const unqualifiedOpaqueRoute = !scope.isGlobal && !parseAgentSessionKey(sessionKey);
  for (const legacySessionKey of Object.keys(store.sessions)) {
    if (legacySessionKey === storeSessionKey) {
      continue;
    }
    const separatorIndex = legacySessionKey.lastIndexOf("\u0000agent:");
    if (separatorIndex < 0) {
      continue;
    }
    const legacyRawSessionKey = legacySessionKey.slice(0, separatorIndex);
    const sameOpaqueRoute = unqualifiedOpaqueRoute && legacyRawSessionKey === scope.conversationKey;
    if (!sameOpaqueRoute && !legacySessionKey.endsWith(agentSuffix)) {
      continue;
    }
    if (!sameOpaqueRoute) {
      const legacyScope = resolveComposerStorageScope(
        state,
        legacyRawSessionKey,
        scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
        store.mainAlias,
      );
      if (legacyScope.conversationKey !== scope.conversationKey) {
        continue;
      }
    }
    const legacySession = normalizeStoredSession(store.sessions[legacySessionKey]);
    if (!legacySession) {
      continue;
    }
    // Normalize embedded routes with their owner row so later durable mutations
    // can find aliases and selected-agent opaque routes after reconnect.
    const queue = legacySession.queue?.map(({ agentId: _agentId, ...item }) => ({
      ...item,
      sessionKey: scope.conversationKey,
      ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
    }));
    session = mergeStoredComposerSessions(session, {
      ...legacySession,
      ...(queue ? { queue } : {}),
    });
    store.sessions[storeSessionKey] = session;
    delete store.sessions[legacySessionKey];
    migrated = true;
  }
  if (!scope.isGlobal || scope.agentScope !== resolveUiKnownSelectedGlobalAgentId(state)) {
    return { session, storeSessionKey, migrated };
  }
  const unresolvedKey = storageSessionKeyForAgentScope(
    scope.conversationKey,
    UNRESOLVED_GLOBAL_AGENT_SCOPE,
  );
  const unresolved =
    storeSessionKey === unresolvedKey
      ? null
      : normalizeStoredSession(store.sessions[unresolvedKey]);
  if (!unresolved) {
    return { session, storeSessionKey, migrated };
  }
  const queue = unresolved.queue?.map((item) =>
    item.agentId ? item : { ...item, agentId: scope.agentScope },
  );
  const merged = mergeStoredComposerSessions(session, {
    ...unresolved,
    ...(queue ? { queue } : {}),
  });
  store.sessions[storeSessionKey] = merged;
  delete store.sessions[unresolvedKey];
  return { session: merged, storeSessionKey, migrated: true };
}

export function resolveStoredChatOutboxScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): StoredChatOutboxScope {
  const storage = getSafeSessionStorage();
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const storedMainAlias = storage ? rememberedStoredMainAlias(storage, target.key) : undefined;
  const scope = resolveComposerStorageScope(state, sessionKey, agentIdOverride, storedMainAlias);
  return {
    sessionKey: scope.conversationKey,
    ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
  };
}

export function storedChatOutboxScopeKey(scope: StoredChatOutboxScope): string {
  const normalizedSessionKey = scope.sessionKey.trim().toLowerCase();
  const agentScope =
    scope.agentId ??
    (normalizedSessionKey === "global" || normalizedSessionKey === DEFAULT_MAIN_KEY
      ? UNRESOLVED_GLOBAL_AGENT_SCOPE
      : DEFAULT_AGENT_ID);
  return storageSessionKeyForAgentScope(scope.sessionKey, agentScope);
}

function parseStoredOutboxStore(
  storage: Storage,
  target: ComposerStorageTarget,
  raw: string,
  version: 1 | 2,
): StoredComposerState | null {
  let parsed: Partial<StoredComposerState>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredComposerState>;
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.version !== version ||
    !parsed.sessions ||
    typeof parsed.sessions !== "object"
  ) {
    return null;
  }
  if (version === 2 && parsed.gatewayOwner !== target.gatewayOwner) {
    // Never replace another Gateway's occupied bucket while deriving badges or
    // restoring a composer; its queued messages belong to a different owner.
    throw new Error("Chat outbox gateway owner mismatch");
  }
  try {
    const sessions: Record<string, StoredComposerSession> = {};
    for (const [sessionKey, value] of Object.entries(parsed.sessions)) {
      const session = normalizeStoredSession(value);
      if (session) {
        sessions[sessionKey] = session;
        observeDraftRevision(session.draftRevision);
        rememberDraftRevision(storage, target.key, sessionKey, session.draftRevision);
      }
    }
    const rawMainAlias = parsed.mainAlias;
    const mainAlias =
      rawMainAlias &&
      typeof rawMainAlias === "object" &&
      typeof rawMainAlias.key === "string" &&
      rawMainAlias.key.trim() &&
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
    const store = parseStoredOutboxStore(storage, target, raw, 2);
    if (store) {
      return store;
    }
  } else if (target.legacyOwnerIsUnambiguous) {
    const legacyRaw = storage.getItem(target.legacyKey);
    const store = legacyRaw ? parseStoredOutboxStore(storage, target, legacyRaw, 1) : null;
    if (store) {
      try {
        writeStoredOutboxStore(storage, target, store);
        storage.removeItem(target.legacyKey);
      } catch {
        // Keep readable shipped rows when browser quota blocks migration.
      }
      return store;
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
  const byNewest = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    b[1].updatedAt - a[1].updatedAt ||
    (b[1].draftRevision ?? 0) - (a[1].draftRevision ?? 0) ||
    a[0].localeCompare(b[0]);
  const unresolvedDraft = drafts.find(([sessionKey]) => sessionKey === unresolvedGlobalKey);
  // Preserve bounded clear fences alongside queued sessions: otherwise an
  // unknown main alias can resurrect an older draft when defaults reconnect.
  const protectedDrafts = [
    ...(unresolvedDraft ? [unresolvedDraft] : []),
    ...drafts
      .filter(
        ([sessionKey, session]) =>
          sessionKey !== unresolvedGlobalKey &&
          !session.draft &&
          session.draftRevision !== undefined,
      )
      .toSorted(byNewest),
  ].slice(0, MAX_STORED_SESSIONS);
  const retained = [
    ...[
      ...outboxes.toSorted(byNewest),
      ...drafts
        .filter(
          ([sessionKey, session]) => sessionKey !== unresolvedGlobalKey && Boolean(session.draft),
        )
        .toSorted(byNewest),
    ].slice(0, MAX_STORED_SESSIONS),
    ...protectedDrafts,
  ];
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
    const outboxes: StoredChatOutbox[] = [];
    for (const [storeSessionKey, session] of Object.entries(store.sessions)) {
      const separatorIndex = storeSessionKey.lastIndexOf(separator);
      if (separatorIndex < 0 || !session.queue?.length) {
        continue;
      }
      const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
      const scope = resolveComposerStorageScope(
        state,
        storeSessionKey.slice(0, separatorIndex),
        agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : agentScope,
        store.mainAlias,
      );
      outboxes.push({
        sessionKey: scope.conversationKey,
        ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
        queue: session.queue.map((item) => applyStoredChatOutboxScope(item, scope)),
      });
    }
    return outboxes.toSorted(
      (left, right) =>
        (left.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) -
          (right.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        left.sessionKey.localeCompare(right.sessionKey),
    );
  } catch {
    return [];
  }
}

export function summarizeStoredChatOutboxes(state: ChatComposerScope): StoredChatOutboxSummary {
  const idsByScope = new Map<string, Set<string>>();
  for (const outbox of listStoredChatOutboxes(state)) {
    const scopeKey = storedChatOutboxScopeKey(outbox);
    const ids = idsByScope.get(scopeKey) ?? new Set<string>();
    for (const item of outbox.queue) {
      if (!item.pendingRunId) {
        ids.add(item.id);
      }
    }
    if (ids.size) {
      idsByScope.set(scopeKey, ids);
    }
  }
  const countsByScope = new Map<string, number>();
  let total = 0;
  for (const [scopeKey, ids] of idsByScope) {
    countsByScope.set(scopeKey, ids.size);
    total += ids.size;
  }
  return { countsByScope, total };
}
