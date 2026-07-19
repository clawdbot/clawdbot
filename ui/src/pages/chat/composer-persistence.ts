import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
} from "../../lib/chat/chat-types.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
// Control UI chat module implements composer persistence behavior.
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v2:";
const MAX_STORED_SESSIONS = 20;
const MAX_STORED_QUEUE_ITEMS = 50;
// Shipped v1 state could hold one full queue under each of 20 alias keys.
// Alias consolidation may exceed today's admission cap, but must retain every
// existing input while the canonical queue drains back below 50.
const MAX_RETAINED_QUEUE_ITEMS = MAX_STORED_SESSIONS * MAX_STORED_QUEUE_ITEMS;
const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;
const UNRESOLVED_GLOBAL_AGENT_SCOPE = "@unresolved";
let lastIssuedDraftRevision = 0;
const draftRevisionHighWaterByStorage = new WeakMap<Storage, Map<string, Map<string, number>>>();
const draftAttemptHighWaterByStorage = new WeakMap<Storage, Map<string, Map<string, number>>>();
export const INTERRUPTED_SETTINGS_WAIT_ERROR =
  "Chat settings update was interrupted. Review and retry when ready.";
export const CHAT_COMPOSER_DRAFT_STORAGE_ERROR =
  "Could not store the previous draft in browser storage. It remains available in this tab.";

type ChatComposerPersistenceState = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: {
    snapshot?: unknown;
  } | null;
  sessionKey: string;
  chatMessage: string;
  chatQueue: ChatQueueItem[];
};

export type ChatComposerScope = Pick<
  ChatComposerPersistenceState,
  "settings" | "assistantAgentId" | "agentsList" | "hello"
>;

type StoredComposerSession = {
  draft?: string;
  draftRevision?: number;
  queue?: ChatQueueItem[];
  updatedAt: number;
};

type StoredComposerMainAlias = {
  key: string;
  agentId: string;
};

type StoredComposerState = {
  version: 2;
  gatewayOwner: string;
  sessions: Record<string, StoredComposerSession>;
  mainAlias?: StoredComposerMainAlias;
};

type ComposerStorageTarget = {
  key: string;
  legacyKey: string;
  gatewayOwner: string;
  legacyOwnerIsUnambiguous: boolean;
};

const storedMainAliasByStorage = new WeakMap<
  Storage,
  Map<string, StoredComposerMainAlias | null>
>();

type RestoreOptions = {
  preserveCurrent?: boolean;
  sessionKey?: string;
};

type ComposerStorageScope = {
  conversationKey: string;
  agentScope: string;
  routingAgentId?: string;
  isGlobal: boolean;
};

export type StoredChatOutboxScope = {
  sessionKey: string;
  agentId?: string;
};

export type StoredChatOutbox = StoredChatOutboxScope & {
  queue: ChatQueueItem[];
};

export type ChatComposerDraftRetry = {
  expectedDraftRevision: number;
  draftRevision: number;
};

type ChatComposerPersistStatus = "persisted" | "conflict" | "storage-failed";

export type ChatComposerPersistResult =
  | { status: "persisted" }
  | { status: "conflict" }
  | ({ status: "storage-failed" } & ChatComposerDraftRetry);

type ChatComposerPersistOptions = {
  agentId?: string;
  draft?: string;
  draftRevision?: number;
  expectedDraftRevision?: number;
};

function storageTargetForGateway(gatewayUrl: string | null | undefined): ComposerStorageTarget {
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

function isBareGlobalAlias(state: ChatComposerScope, sessionKey: string): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  return normalized === "main" || normalized === resolveUiConfiguredMainKey(state);
}

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
  const next = {
    key,
    agentId: resolveUiDefaultAgentId(state),
  };
  if (store.mainAlias?.key === next.key && store.mainAlias.agentId === next.agentId) {
    return false;
  }
  store.mainAlias = next;
  return true;
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

function isComposerGlobalScope(state: ChatComposerScope, sessionKey: string): boolean {
  return (
    isUiGlobalSessionKey(sessionKey) ||
    isBareGlobalAlias(state, sessionKey) ||
    resolveUiGlobalAliasAgentId(state, sessionKey) !== null
  );
}

function resolveComposerStorageScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
  storedMainAlias?: StoredComposerMainAlias,
): ComposerStorageScope {
  const parsed = parseAgentSessionKey(sessionKey);
  const normalizedSessionKey = sessionKey.trim().toLowerCase();
  const knownSessionDefaults = hasKnownSessionDefaults(state);
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
  const isGlobal = isComposerGlobalScope(state, sessionKey) || storedMainAliasMatches;
  const explicitAgentId = parsed?.agentId ?? agentIdOverride?.trim();
  const knownAgentId = resolveUiKnownSelectedGlobalAgentId(state);
  const bareGlobalAgentId =
    knownSessionDefaults && !parsed && isBareGlobalAlias(state, sessionKey)
      ? resolveUiDefaultAgentId(state)
      : undefined;
  const routingAgentId = isGlobal
    ? explicitAgentId
      ? normalizeAgentId(explicitAgentId)
      : bareGlobalAgentId
        ? normalizeAgentId(bareGlobalAgentId)
        : storedBareMainAliasAgentId
          ? normalizeAgentId(storedBareMainAliasAgentId)
          : unresolvedBareMain
            ? undefined
            : knownAgentId
              ? normalizeAgentId(knownAgentId)
              : storedMainAliasMatches
                ? normalizeAgentId(storedMainAlias.agentId)
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

function nextDraftRevision(baseline = 0): number {
  const revision = Math.max(Date.now(), lastIssuedDraftRevision + 1, baseline + 1);
  lastIssuedDraftRevision = revision;
  return revision;
}

function rememberDraftRevision(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
  draftRevision: number | undefined,
) {
  if (draftRevision === undefined) {
    return;
  }
  let byStorageKey = draftRevisionHighWaterByStorage.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    draftRevisionHighWaterByStorage.set(storage, byStorageKey);
  }
  let bySession = byStorageKey.get(storageKey);
  if (!bySession) {
    bySession = new Map();
    byStorageKey.set(storageKey, bySession);
  }
  bySession.set(storeSessionKey, Math.max(bySession.get(storeSessionKey) ?? 0, draftRevision));
}

function rememberDraftAttempt(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
  draftRevision: number,
) {
  let byStorageKey = draftAttemptHighWaterByStorage.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    draftAttemptHighWaterByStorage.set(storage, byStorageKey);
  }
  let bySession = byStorageKey.get(storageKey);
  if (!bySession) {
    bySession = new Map();
    byStorageKey.set(storageKey, bySession);
  }
  bySession.set(storeSessionKey, Math.max(bySession.get(storeSessionKey) ?? 0, draftRevision));
}

function rememberedDraftRevision(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
): number {
  return draftRevisionHighWaterByStorage.get(storage)?.get(storageKey)?.get(storeSessionKey) ?? 0;
}

function rememberedDraftAttempt(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
): number {
  return draftAttemptHighWaterByStorage.get(storage)?.get(storageKey)?.get(storeSessionKey) ?? 0;
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

function resolveStoredComposerSession(
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
        lastIssuedDraftRevision = Math.max(lastIssuedDraftRevision, session.draftRevision ?? 0);
        rememberDraftRevision(storage, target.key, sessionKey, session.draftRevision);
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

function readStore(storage: Storage, target: ComposerStorageTarget): StoredComposerState {
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
          writeStore(storage, target, store);
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

function writeStore(
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
  const unresolvedGlobalKey = storageSessionKeyForAgentScope(
    "global",
    UNRESOLVED_GLOBAL_AGENT_SCOPE,
  );
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

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeChatAttachment(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = normalizeOptionalString(entry.id);
  const mimeType = normalizeOptionalString(entry.mimeType);
  if (!id || !mimeType) {
    return null;
  }
  const restored: ChatAttachment = { id, mimeType };
  const fileName = normalizeOptionalString(entry.fileName);
  if (fileName) {
    restored.fileName = fileName;
  }
  if (typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)) {
    restored.sizeBytes = entry.sizeBytes;
  }
  const dataUrl = normalizeOptionalString(entry.dataUrl);
  if (dataUrl) {
    restored.dataUrl = dataUrl;
  }
  return restored;
}

function serializeChatAttachment(attachment: ChatAttachment): ChatAttachment | null {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  if (!dataUrl) {
    return null;
  }
  return {
    id: attachment.id,
    mimeType: attachment.mimeType,
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
    dataUrl,
  };
}

function normalizeSkillWorkshopRevision(
  value: unknown,
): ChatQueueSkillWorkshopRevision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const proposalId = normalizeOptionalString(entry.proposalId);
  if (!proposalId) {
    return undefined;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  return {
    proposalId,
    ...(agentId ? { agentId: normalizeAgentId(agentId) } : {}),
  };
}

function serializeQueueItem(item: ChatQueueItem): ChatQueueItem | null {
  const id = normalizeOptionalString(item.id);
  const text = typeof item.text === "string" ? item.text : "";
  if (!id || (!text.trim() && !item.attachments?.length)) {
    return null;
  }
  if (item.pendingRunId) {
    return null;
  }
  if (item.sendState === "sending" && !item.sendRunId) {
    return null;
  }
  const attachments = item.attachments?.map(serializeChatAttachment) ?? [];
  if (item.attachments?.length && attachments.some((attachment) => attachment === null)) {
    return null;
  }
  const sendState =
    item.sendState === "sending"
      ? "waiting-reconnect"
      : item.sendState === "executing-command" || item.sendState === "steering"
        ? "unconfirmed"
        : item.sendState === "waiting-model"
          ? "failed"
          : item.sendState === "failed" ||
              item.sendState === "unconfirmed" ||
              item.sendState === "waiting-idle" ||
              item.sendState === "waiting-reconnect"
            ? item.sendState
            : undefined;
  const sendError =
    item.sendState === "waiting-model" ? INTERRUPTED_SETTINGS_WAIT_ERROR : item.sendError;
  const skillWorkshopRevision = normalizeSkillWorkshopRevision(item.skillWorkshopRevision);
  return {
    id,
    text,
    createdAt:
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
    ...(item.kind === "queued" || item.kind === "steered" ? { kind: item.kind } : {}),
    ...(attachments.length ? { attachments: attachments as ChatAttachment[] } : {}),
    ...(typeof item.refreshSessions === "boolean" ? { refreshSessions: item.refreshSessions } : {}),
    ...(item.replyToId ? { replyToId: item.replyToId } : {}),
    ...(item.localCommandArgs ? { localCommandArgs: item.localCommandArgs } : {}),
    ...(item.localCommandName ? { localCommandName: item.localCommandName } : {}),
    ...(item.sessionKey ? { sessionKey: item.sessionKey } : {}),
    ...(item.agentId ? { agentId: item.agentId } : {}),
    ...(skillWorkshopRevision ? { skillWorkshopRevision } : {}),
    ...(sendState ? { sendState } : {}),
    ...(sendError ? { sendError } : {}),
    ...(item.sendRunId ? { sendRunId: item.sendRunId } : {}),
    ...(typeof item.sendAttempts === "number" && Number.isFinite(item.sendAttempts)
      ? { sendAttempts: item.sendAttempts }
      : {}),
  };
}

function normalizeQueueItem(value: unknown): ChatQueueItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = normalizeOptionalString(entry.id);
  const text = typeof entry.text === "string" ? entry.text : "";
  const createdAt =
    typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now();
  if (!id || (!text.trim() && !Array.isArray(entry.attachments))) {
    return null;
  }
  const attachments = Array.isArray(entry.attachments)
    ? entry.attachments
        .map(normalizeChatAttachment)
        .filter((item): item is ChatAttachment => item !== null)
    : [];
  const item: ChatQueueItem = { id, text, createdAt };
  if (entry.kind === "queued" || entry.kind === "steered") {
    item.kind = entry.kind;
  }
  if (attachments.length) {
    item.attachments = attachments;
  }
  const refreshSessions = normalizeOptionalBoolean(entry.refreshSessions);
  if (refreshSessions !== undefined) {
    item.refreshSessions = refreshSessions;
  }
  const replyToId = normalizeOptionalString(entry.replyToId);
  if (replyToId) {
    item.replyToId = replyToId;
  }
  if (
    entry.sendState === "failed" ||
    entry.sendState === "unconfirmed" ||
    entry.sendState === "waiting-idle" ||
    entry.sendState === "waiting-reconnect"
  ) {
    item.sendState = entry.sendState;
  } else if (entry.sendState === "waiting-model") {
    item.sendState = "failed";
    item.sendError = INTERRUPTED_SETTINGS_WAIT_ERROR;
  }
  const sendError = normalizeOptionalString(entry.sendError);
  if (sendError) {
    item.sendError = sendError;
  }
  const sendRunId = normalizeOptionalString(entry.sendRunId);
  if (sendRunId) {
    item.sendRunId = sendRunId;
  }
  if (typeof entry.sendAttempts === "number" && Number.isFinite(entry.sendAttempts)) {
    item.sendAttempts = entry.sendAttempts;
  }
  const localCommandArgs = normalizeOptionalString(entry.localCommandArgs);
  if (localCommandArgs) {
    item.localCommandArgs = localCommandArgs;
  }
  const localCommandName = normalizeOptionalString(entry.localCommandName);
  if (localCommandName) {
    item.localCommandName = localCommandName;
  }
  const sessionKey = normalizeOptionalString(entry.sessionKey);
  if (sessionKey) {
    item.sessionKey = sessionKey;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  if (agentId) {
    item.agentId = normalizeAgentId(agentId);
  }
  const skillWorkshopRevision = normalizeSkillWorkshopRevision(entry.skillWorkshopRevision);
  if (skillWorkshopRevision) {
    item.skillWorkshopRevision = skillWorkshopRevision;
  }
  return item;
}

function normalizeStoredSession(value: unknown): StoredComposerSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const draft = typeof entry.draft === "string" ? entry.draft : undefined;
  const normalizedQueue = Array.isArray(entry.queue)
    ? entry.queue
        .slice(0, MAX_RETAINED_QUEUE_ITEMS)
        .map(normalizeQueueItem)
        .filter((item): item is ChatQueueItem => item !== null)
    : undefined;
  // v1 writers used bounded tombstones. Consume them while reading legacy
  // state, but never copy them into the item-level outbox representation.
  const removedQueueItemIds = Array.isArray(entry.removedQueueItemIds)
    ? entry.removedQueueItemIds
        .map(normalizeOptionalString)
        .filter((id): id is string => id !== undefined)
    : undefined;
  const removedIds = new Set(removedQueueItemIds ?? []);
  const queue = normalizedQueue?.filter((item) => !removedIds.has(item.id));
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : Date.now();
  const storedDraftRevision =
    typeof entry.draftRevision === "number" && Number.isSafeInteger(entry.draftRevision)
      ? entry.draftRevision
      : undefined;
  // Legacy rows did not version drafts, so their row timestamp is the best
  // available ordering signal. Queue-only rows must not claim draft ownership.
  const draftRevision = storedDraftRevision ?? (draft ? updatedAt : undefined);
  if (!draft && draftRevision === undefined && (!queue || queue.length === 0)) {
    return null;
  }
  return {
    ...(draft ? { draft } : {}),
    ...(draftRevision !== undefined ? { draftRevision } : {}),
    ...(queue && queue.length > 0 ? { queue } : {}),
    updatedAt,
  };
}

function serializeQueueItemForScope(
  item: ChatQueueItem,
  scope: ComposerStorageScope,
): ChatQueueItem | null {
  const serialized = serializeQueueItem(item);
  if (!serialized) {
    return null;
  }
  const { agentId: _agentId, ...withoutAgentId } = serialized;
  return {
    ...withoutAgentId,
    sessionKey: scope.conversationKey,
    ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
  };
}

function queueItemVersionMatches(
  stored: ChatQueueItem,
  expected: ChatQueueItem,
  scope: ComposerStorageScope,
): boolean {
  const canonicalExpected = serializeQueueItemForScope(expected, scope);
  return Boolean(
    canonicalExpected &&
    stored.id === canonicalExpected.id &&
    stored.sendRunId === canonicalExpected.sendRunId &&
    stored.sendAttempts === canonicalExpected.sendAttempts &&
    stored.sendState === canonicalExpected.sendState &&
    stored.agentId === canonicalExpected.agentId &&
    stored.sessionKey === canonicalExpected.sessionKey,
  );
}

function queueItemsEqual(
  stored: ChatQueueItem,
  expected: ChatQueueItem,
  scope: ComposerStorageScope,
): boolean {
  const canonicalStored = serializeQueueItemForScope(stored, scope);
  const canonicalExpected = serializeQueueItemForScope(expected, scope);
  return Boolean(
    canonicalStored &&
    canonicalExpected &&
    JSON.stringify(canonicalStored) === JSON.stringify(canonicalExpected),
  );
}

function writeStoredComposerSession(
  store: StoredComposerState,
  storeSessionKey: string,
  session: StoredComposerSession | null,
  queue: ChatQueueItem[],
): void {
  if (!session?.draft && session?.draftRevision === undefined && queue.length === 0) {
    delete store.sessions[storeSessionKey];
    return;
  }
  store.sessions[storeSessionKey] = {
    ...(session?.draft ? { draft: session.draft } : {}),
    ...(session?.draftRevision !== undefined ? { draftRevision: session.draftRevision } : {}),
    ...(queue.length ? { queue } : {}),
    updatedAt: Date.now(),
  };
}

type ChatComposerDraftRevisionState = {
  committed: number;
  latestAttempt: number;
};

function loadChatComposerDraftRevisionState(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): ChatComposerDraftRevisionState {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return { committed: 0, latestAttempt: 0 };
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const resolved = resolveStoredComposerSession(store, state, sessionKey, agentIdOverride);
    if (resolved.migrated) {
      try {
        writeStore(storage, target, store);
      } catch {
        // The readable draft is still the concurrency baseline for this pane.
      }
    }
    const storedDraftRevision = resolved.session?.draftRevision;
    rememberDraftRevision(storage, target.key, resolved.storeSessionKey, storedDraftRevision);
    const committed = Math.max(
      storedDraftRevision ?? 0,
      rememberedDraftRevision(storage, target.key, resolved.storeSessionKey),
    );
    return {
      committed,
      latestAttempt: Math.max(
        committed,
        rememberedDraftAttempt(storage, target.key, resolved.storeSessionKey),
      ),
    };
  } catch {
    return { committed: 0, latestAttempt: 0 };
  }
}

export function loadChatComposerDraftRevision(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): number {
  return loadChatComposerDraftRevisionState(state, sessionKey, agentIdOverride).latestAttempt;
}

export function loadChatComposerCommittedDraftRevision(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): number {
  return loadChatComposerDraftRevisionState(state, sessionKey, agentIdOverride).committed;
}

export function loadChatComposerSnapshot(
  state: Pick<
    ChatComposerPersistenceState,
    "settings" | "assistantAgentId" | "agentsList" | "hello"
  >,
  sessionKey: string,
  agentIdOverride?: string,
): { draft: string; queue: ChatQueueItem[] } | null {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return null;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    let scope = resolveComposerStorageScope(state, sessionKey, agentIdOverride, store.mainAlias);
    let resolved = resolveStoredComposerSession(store, state, sessionKey, agentIdOverride);
    if (!resolved.session && scope.isGlobal && scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE) {
      const separator = "\u0000agent:";
      const candidateAgentScopes = new Set<string>();
      for (const [storeSessionKey, value] of Object.entries(store.sessions)) {
        const separatorIndex = storeSessionKey.lastIndexOf(separator);
        if (separatorIndex < 0) {
          continue;
        }
        const rawSessionKey = storeSessionKey.slice(0, separatorIndex);
        const agentScope = storeSessionKey.slice(separatorIndex + separator.length);
        const session = normalizeStoredSession(value);
        const candidateScope = resolveComposerStorageScope(
          state,
          rawSessionKey,
          agentScope,
          store.mainAlias,
        );
        if (
          agentScope !== UNRESOLVED_GLOBAL_AGENT_SCOPE &&
          candidateScope.isGlobal &&
          session !== null
        ) {
          candidateAgentScopes.add(agentScope);
        }
      }
      if (candidateAgentScopes.size === 1) {
        const candidateAgentScope = candidateAgentScopes.values().next().value;
        if (typeof candidateAgentScope === "string") {
          scope = resolveComposerStorageScope(
            state,
            sessionKey,
            candidateAgentScope,
            store.mainAlias,
          );
          resolved = resolveStoredComposerSession(store, state, sessionKey, candidateAgentScope);
        }
      }
    }
    if (resolved.migrated) {
      try {
        writeStore(storage, target, store);
      } catch {
        // Migration persistence is best-effort; readable drafts and outboxes remain usable.
      }
    }
    const session = resolved.session;
    if (!session || (!session.draft && !session.queue?.length)) {
      return null;
    }
    return {
      draft: session.draft ?? "",
      queue: (session.queue ?? [])
        .map((item) => serializeQueueItemForScope(item, scope))
        .filter((item): item is ChatQueueItem => item !== null)
        .map((item) => Object.assign(item, { sessionKey })),
    };
  } catch {
    return null;
  }
}

function persistChatComposerStateResult(
  state: ChatComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): ChatComposerPersistStatus {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim()) {
    return "storage-failed";
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const { session, storeSessionKey } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      options.agentId,
    );
    const draft = Object.hasOwn(options, "draft") ? (options.draft ?? "") : state.chatMessage;
    const storedDraftRevision = session?.draftRevision;
    rememberDraftRevision(storage, target.key, storeSessionKey, storedDraftRevision);
    // Draft-only rows are bounded and may evict a clear tombstone. Retain the
    // seen revision while this tab is alive so an older failed write cannot
    // treat an evicted scope as revision zero and resurrect stale input.
    const committedDraftRevision = Math.max(
      storedDraftRevision ?? 0,
      rememberedDraftRevision(storage, target.key, storeSessionKey),
    );
    const newestDraftAttempt = Math.max(
      committedDraftRevision,
      rememberedDraftAttempt(storage, target.key, storeSessionKey),
    );
    const draftRevision = options.draftRevision ?? nextDraftRevision(newestDraftAttempt);
    if (!Number.isSafeInteger(draftRevision) || draftRevision <= 0) {
      return "conflict";
    }
    const storedDraft = session?.draft ?? "";
    const expectedDraftRevision = options.expectedDraftRevision;
    const committedMatchesExpected =
      expectedDraftRevision === undefined ||
      committedDraftRevision === expectedDraftRevision ||
      (storedDraftRevision === draftRevision && storedDraft === draft);
    // Reserve every accepted attempt before touching storage. A newer failed
    // edit or clear must fence out older pane fallbacks when capacity recovers.
    if (
      !committedMatchesExpected ||
      draftRevision < newestDraftAttempt ||
      (storedDraftRevision === draftRevision && storedDraft !== draft)
    ) {
      return "conflict";
    }
    rememberDraftAttempt(storage, target.key, storeSessionKey, draftRevision);
    store.sessions[storeSessionKey] = {
      ...(draft ? { draft } : {}),
      draftRevision,
      ...(session?.queue?.length ? { queue: session.queue } : {}),
      updatedAt: Date.now(),
    };
    writeStore(storage, target, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, target),
      state,
      sessionKey,
      options.agentId,
    ).session;
    if (persisted?.draftRevision === draftRevision && (persisted.draft ?? "") === draft) {
      return "persisted";
    }
    // Retention limits can make a successful storage write omit this draft.
    // Only a same/newer revision is a concurrency conflict; a missing or older
    // row remains retryable as a storage-capacity failure.
    return (persisted?.draftRevision ?? 0) >= draftRevision ? "conflict" : "storage-failed";
  } catch {
    // Best-effort only: quota and privacy-mode storage errors should not break chat.
    return "storage-failed";
  }
}

export function persistChatComposerState(
  state: ChatComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): boolean {
  return persistChatComposerStateResult(state, sessionKey, options) === "persisted";
}

export function admitStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  item: ChatQueueItem,
  agentId?: string,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim()) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = resolveComposerStorageScope(
      state,
      sessionKey,
      agentId ?? item.agentId,
      store.mainAlias,
    );
    const serialized = serializeQueueItemForScope(item, scope);
    if (!serialized) {
      return false;
    }
    const { session, storeSessionKey, migrated } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    const queue = session?.queue ?? [];
    const existing = queue.find((entry) => entry.id === serialized.id);
    if (existing) {
      if (!queueItemsEqual(existing, serialized, scope)) {
        return false;
      }
      if (migrated) {
        writeStore(storage, target, store);
      }
      return true;
    }
    if (queue.length >= MAX_STORED_QUEUE_ITEMS) {
      return false;
    }
    writeStoredComposerSession(store, storeSessionKey, session, [...queue, serialized]);
    writeStore(storage, target, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, target),
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    ).session?.queue?.find((entry) => entry.id === serialized.id);
    return Boolean(persisted && queueItemsEqual(persisted, serialized, scope));
  } catch {
    return false;
  }
}

export function updateStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  expected: ChatQueueItem,
  next: ChatQueueItem,
  agentId?: string,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim() || expected.id !== next.id) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = resolveComposerStorageScope(
      state,
      sessionKey,
      agentId ?? expected.agentId ?? next.agentId,
      store.mainAlias,
    );
    const serializedNext = serializeQueueItemForScope(next, scope);
    if (!serializedNext) {
      return false;
    }
    const { session, storeSessionKey } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    const queue = session?.queue ?? [];
    const index = queue.findIndex((entry) => entry.id === expected.id);
    const stored = queue[index];
    if (!stored || !queueItemVersionMatches(stored, expected, scope)) {
      return false;
    }
    const nextQueue = queue.slice();
    nextQueue[index] = serializedNext;
    writeStoredComposerSession(store, storeSessionKey, session, nextQueue);
    writeStore(storage, target, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, target),
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    ).session?.queue?.find((entry) => entry.id === serializedNext.id);
    return Boolean(persisted && queueItemsEqual(persisted, serializedNext, scope));
  } catch {
    return false;
  }
}

export function removeStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  id: string,
  expected?: ChatQueueItem,
  agentId?: string,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim() || !id.trim()) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = resolveComposerStorageScope(
      state,
      sessionKey,
      agentId ?? expected?.agentId,
      store.mainAlias,
    );
    const { session, storeSessionKey } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    const queue = session?.queue ?? [];
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) {
      return true;
    }
    const stored = queue[index];
    if (!stored || (expected && !queueItemVersionMatches(stored, expected, scope))) {
      return false;
    }
    writeStoredComposerSession(
      store,
      storeSessionKey,
      session,
      queue.filter((_, queueIndex) => queueIndex !== index),
    );
    writeStore(storage, target, store);
    const persisted = resolveStoredComposerSession(
      readStore(storage, target),
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    ).session?.queue?.some((item) => item.id === id);
    return !persisted;
  } catch {
    return false;
  }
}

export function listStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return [];
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const separator = "\u0000agent:";
    let migrated = false;
    const selectedGlobalAgentId = resolveUiKnownSelectedGlobalAgentId(state);
    const defaultGlobalAgentId = hasKnownSessionDefaults(state)
      ? resolveUiDefaultAgentId(state)
      : undefined;
    if (defaultGlobalAgentId) {
      const defaultGlobal = resolveStoredComposerSession(
        store,
        state,
        "global",
        defaultGlobalAgentId,
      );
      migrated = defaultGlobal.migrated;
    }
    if (selectedGlobalAgentId) {
      const selectedGlobal = resolveStoredComposerSession(
        store,
        state,
        "global",
        selectedGlobalAgentId,
      );
      migrated = selectedGlobal.migrated || migrated;
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
        writeStore(storage, target, store);
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
      const queue = session.queue
        .map((item) => serializeQueueItemForScope(item, scope))
        .filter((item): item is ChatQueueItem => item !== null);
      if (!queue.length) {
        continue;
      }
      outboxes.push({
        sessionKey: scope.conversationKey,
        ...(scope.routingAgentId ? { agentId: scope.routingAgentId } : {}),
        queue,
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

export function restoreChatComposerState(
  state: ChatComposerPersistenceState,
  options: RestoreOptions = {},
): boolean {
  const sessionKey = options.sessionKey ?? state.sessionKey;
  const snapshot = loadChatComposerSnapshot(state, sessionKey);
  if (!snapshot) {
    return false;
  }
  if (!options.preserveCurrent || !state.chatMessage) {
    state.chatMessage = snapshot.draft;
  }
  if ((!options.preserveCurrent && snapshot.queue.length > 0) || state.chatQueue.length === 0) {
    state.chatQueue = snapshot.queue;
  }
  return true;
}

type ChatComposerDraftSnapshot = {
  sessionKey: string;
  chatMessage: string;
  agentId?: string;
  expectedDraftRevision: number;
  draftRevision: number;
};

export class ChatComposerPersistence {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ready = false;
  private pending: ChatComposerDraftSnapshot | null = null;
  private lastPersisted: ChatComposerDraftSnapshot | null = null;
  private committedDraftRevision = 0;
  private latestDraftRevision = 0;

  constructor(private readonly getState: () => ChatComposerPersistenceState | undefined) {}

  start() {
    const state = this.getState();
    if (!state) {
      return;
    }
    this.ready = true;
    this.pending = null;
    const revisions = this.readDraftRevisions(state);
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
  }

  stop() {
    this.persistNow();
    this.ready = false;
    this.pending = null;
    this.clearTimer();
  }

  restore(options: RestoreOptions = {}): boolean {
    const state = this.getState();
    if (!state) {
      return false;
    }
    const restored = restoreChatComposerState(state, options);
    this.pending = null;
    this.clearTimer();
    const revisions = this.readDraftRevisions(state);
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
    return restored;
  }

  schedule() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    const current = this.snapshot(state);
    if (this.isUnchanged(current)) {
      if (!this.pending) {
        this.clearTimer();
        return;
      }
      if (this.pending.chatMessage === current.chatMessage) {
        this.clearTimer();
        this.timer = globalThis.setTimeout(
          () => this.persistNow(),
          CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS,
        );
        return;
      }
    }
    const baseline = Math.max(this.latestDraftRevision, this.pending?.draftRevision ?? 0);
    const draftRevision = nextDraftRevision(baseline);
    this.latestDraftRevision = draftRevision;
    this.pending = this.snapshot(state, draftRevision, this.committedDraftRevision);
    this.clearTimer();
    this.timer = globalThis.setTimeout(
      () => this.persistNow(),
      CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS,
    );
  }

  persistNow() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    let snapshot = this.pending;
    if (!snapshot) {
      const current = this.snapshot(state);
      if (this.isUnchanged(current)) {
        return;
      }
      snapshot = this.snapshot(
        state,
        nextDraftRevision(this.latestDraftRevision),
        this.committedDraftRevision,
      );
      this.latestDraftRevision = snapshot.draftRevision;
    }
    this.clearTimer();
    this.pending = this.persistSnapshot(state, snapshot).status === "persisted" ? null : snapshot;
  }

  persistChangedState() {
    this.persistNow();
  }

  scopeForRouteSwitch(): StoredChatOutboxScope | null {
    const state = this.getState();
    if (!state) {
      return null;
    }
    const current = this.snapshot(state);
    const snapshot =
      this.pending ?? (this.isUnchanged(current) ? (this.lastPersisted ?? current) : current);
    return resolveStoredChatOutboxScope(state, snapshot.sessionKey, snapshot.agentId);
  }

  persistForRouteSwitch(): boolean {
    return this.persistForRouteSwitchResult().status === "persisted";
  }

  persistForRouteSwitchResult(): ChatComposerPersistResult {
    const state = this.getState();
    if (!state) {
      return { status: "persisted" };
    }
    let snapshot = this.pending;
    let enforceExpectedRevision = false;
    const current = this.snapshot(state);
    if (!snapshot && this.ready && this.isUnchanged(current)) {
      const baseline = this.lastPersisted ?? current;
      if (!baseline.chatMessage) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      const revisions = this.readDraftRevisions(state, baseline.sessionKey, baseline.agentId);
      const storedRevision = revisions.committed;
      const stored = loadChatComposerSnapshot(state, baseline.sessionKey, baseline.agentId);
      if (storedRevision === baseline.draftRevision && stored?.draft === baseline.chatMessage) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      if (storedRevision !== baseline.draftRevision || Boolean(stored?.draft)) {
        return { status: "conflict" };
      }
      // A newer failed attempt still represents newer pane input. An
      // untouched pane must not mint a later revision for its stale draft and
      // fence that edit out merely because retention evicted the stored row.
      if (revisions.latestAttempt > baseline.draftRevision) {
        return { status: "conflict" };
      }
      snapshot = {
        ...baseline,
        expectedDraftRevision: storedRevision,
        draftRevision: nextDraftRevision(
          Math.max(storedRevision, revisions.latestAttempt, this.latestDraftRevision),
        ),
      };
      this.latestDraftRevision = snapshot.draftRevision;
      enforceExpectedRevision = true;
    } else if (!snapshot && !this.ready && !current.chatMessage) {
      this.pending = null;
      this.clearTimer();
      return { status: "persisted" };
    }
    snapshot ??= this.snapshot(
      state,
      nextDraftRevision(this.latestDraftRevision),
      this.committedDraftRevision,
    );
    this.latestDraftRevision = Math.max(this.latestDraftRevision, snapshot.draftRevision);
    this.clearTimer();
    const result = this.persistSnapshot(state, snapshot, enforceExpectedRevision);
    this.pending = result.status === "persisted" ? null : snapshot;
    return result;
  }

  adoptCurrentRoute() {
    const state = this.getState();
    if (!state) {
      return;
    }
    this.pending = null;
    this.clearTimer();
    const revisions = this.readDraftRevisions(state);
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
  }

  private persistSnapshot(
    state: ChatComposerPersistenceState,
    snapshot: ChatComposerDraftSnapshot,
    enforceExpectedRevision = false,
  ): ChatComposerPersistResult {
    const status = persistChatComposerStateResult(state, snapshot.sessionKey, {
      agentId: snapshot.agentId,
      draft: snapshot.chatMessage,
      draftRevision: snapshot.draftRevision,
      ...(enforceExpectedRevision ? { expectedDraftRevision: snapshot.expectedDraftRevision } : {}),
    });
    if (status === "persisted") {
      this.committedDraftRevision = snapshot.draftRevision;
      this.latestDraftRevision = Math.max(this.latestDraftRevision, snapshot.draftRevision);
      this.lastPersisted = snapshot;
      return { status };
    }
    if (status === "storage-failed") {
      return {
        status,
        expectedDraftRevision: snapshot.expectedDraftRevision,
        draftRevision: snapshot.draftRevision,
      };
    }
    return { status };
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private isUnchanged(snapshot: ChatComposerDraftSnapshot): boolean {
    const last = this.lastPersisted;
    return Boolean(
      last && last.sessionKey === snapshot.sessionKey && last.chatMessage === snapshot.chatMessage,
    );
  }

  private snapshot(
    state: ChatComposerPersistenceState,
    draftRevision: number = this.latestDraftRevision,
    expectedDraftRevision: number = this.committedDraftRevision,
  ): ChatComposerDraftSnapshot {
    const scope = resolveStoredChatOutboxScope(state, state.sessionKey);
    return {
      sessionKey: state.sessionKey,
      chatMessage: state.chatMessage,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      expectedDraftRevision,
      draftRevision,
    };
  }

  private readDraftRevisions(
    state: ChatComposerPersistenceState,
    sessionKey: string = state.sessionKey,
    agentId?: string,
  ): ChatComposerDraftRevisionState {
    // Cold-offline restore may display the sole known agent's draft while the
    // current route is still unresolved. CAS must target the unresolved row so
    // an offline edit can be admitted and migrated once defaults arrive.
    return loadChatComposerDraftRevisionState(state, sessionKey, agentId);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
