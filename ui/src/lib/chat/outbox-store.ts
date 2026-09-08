import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
  hasUiSessionDefaults,
  resolveUiConversationIdentity,
} from "../sessions/session-key.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import { removeOutboxPayloads } from "./outbox-payload-store.runtime.ts";
import {
  MAX_STORED_SESSIONS,
  normalizeStoredSession,
  type StoredComposerSession,
} from "./outbox-store-codec.ts";
import { observeDraftRevision, rememberDraftRevision } from "./outbox-store-draft-state.ts";

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const PREVIOUS_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v2:";
const BLOB_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v3:";
const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v4:";
const UNRESOLVED_GLOBAL_AGENT_SCOPE = "@unresolved";
const storedChatOutboxChangeListeners = new Set<() => void>();
let storageChangeListenerInstalled = false;

export type ChatComposerScope = {
  client?: { recoveryScope?: string; recoveryScopeReady?: boolean } | null;
  connected?: boolean;
  selectedChatSessionIncognito?: boolean;
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null; scope?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

type ComposerStorageTarget = {
  key: string;
  legacyKey: string;
  previousKey: string;
  blobKey: string;
  gatewayOwner: string;
  legacyOwnerIsUnambiguous: boolean;
};

export type StoredChatOutboxScope = {
  sessionKey: string;
  agentId?: string;
};

export type StoredComposerState = {
  version: 4;
  gatewayOwner: string;
  sessions: Record<string, StoredComposerSession>;
  recovery: Record<string, StoredComposerRecovery>;
  legacyReceipts?: Partial<Record<"1" | "2" | "3", string>>;
  recoveryBlocked?: true;
};

export type StoredComposerRecovery = {
  sourceVersion: 1 | 2 | 3 | 4;
  sourceScopeKey: string;
  session: StoredComposerSession;
};

// Keep the original recovery bound; excess whole legacy sources remain untouched.
const MAX_RECOVERY_ROWS = 80;
const pendingLegacyTransfers = new WeakMap<
  StoredComposerState,
  Array<{ key: string; raw: string }>
>();
// Projection reads share one normalized snapshot until a canonical write or
// browser storage event invalidates it; mutation paths still reread for CAS.
const projectedStoreByStorage = new WeakMap<Storage, Map<string, StoredComposerState>>();
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
  if (event.key === null && event.storageArea) {
    projectedStoreByStorage.get(event.storageArea)?.clear();
    notifyStoredChatOutboxChanges();
    return;
  }
  if (
    event.key?.startsWith(STORAGE_KEY_PREFIX) ||
    event.key?.startsWith(LEGACY_STORAGE_KEY_PREFIX) ||
    event.key?.startsWith(PREVIOUS_STORAGE_KEY_PREFIX) ||
    event.key?.startsWith(BLOB_STORAGE_KEY_PREFIX)
  ) {
    if (event.storageArea) {
      projectedStoreByStorage.get(event.storageArea)?.clear();
    }
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
    previousKey: `${PREVIOUS_STORAGE_KEY_PREFIX}${encodedOwner}`,
    blobKey: `${BLOB_STORAGE_KEY_PREFIX}${encodedOwner}`,
    gatewayOwner,
    // Shipped v1 keys omitted the owner and truncated its encoded value. A
    // truncated row cannot prove which same-prefix gateway owns its outbox.
    legacyOwnerIsUnambiguous: encodedOwner.length < 240,
  };
}

export function parseStoredChatOutboxScope(key: string): StoredChatOutboxScope | null {
  const separator = "\u0000agent:";
  const index = key.lastIndexOf(separator);
  if (index < 1) {
    return null;
  }
  const sessionKey = key.slice(0, index);
  const agentScope = key.slice(index + separator.length);
  const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (parsedAgentId && normalizeAgentId(agentScope) !== normalizeAgentId(parsedAgentId)) {
    return null;
  }
  const agentId =
    parsedAgentId ??
    (sessionKey === "global" && agentScope !== UNRESOLVED_GLOBAL_AGENT_SCOPE
      ? agentScope
      : undefined);
  return { sessionKey, ...(agentId ? { agentId: normalizeAgentId(agentId) } : {}) };
}

// Only admissions made before defaults arrived can move after reconnect. Stored
// canonical identities never get reinterpreted by a later config or selection.
export function resolvePendingComposerSessions(
  store: StoredComposerState,
  state: ChatComposerScope,
): boolean {
  let migrated = false;
  for (const [key, pending] of Object.entries(store.sessions)) {
    if (!pending.awaitingDefaults || !hasUiSessionDefaults(state)) {
      continue;
    }
    const source = parseStoredChatOutboxScope(key);
    if (!source) {
      continue;
    }
    const resolved = resolveUiConversationIdentity(state, source.sessionKey, source.agentId);
    const nextKey = storedChatOutboxScopeKey(resolved);
    const { awaitingDefaults: _, ...session } = pending;
    const destination = store.sessions[nextKey];
    if (nextKey !== key && destination) {
      const existingIds = new Set(destination.queue?.map((item) => item.id));
      const conflict = session.queue?.some((item) => existingIds.has(item.id));
      const sourceNewer = (session.draftRevision ?? 0) > (destination.draftRevision ?? 0);
      if (conflict || (session.draft && !sourceNewer)) {
        holdComposerRecovery(store, `pending:${key}`, 4, key, session);
      } else {
        const draftOwner = sourceNewer ? session : destination;
        store.sessions[nextKey] = {
          ...draftOwner,
          queue: [
            ...(destination.queue ?? []),
            ...(session.queue ?? []).map((item) => applyStoredChatOutboxScope(item, resolved)),
          ],
          updatedAt: Math.max(session.updatedAt, destination.updatedAt),
        };
      }
    } else {
      store.sessions[nextKey] = {
        ...session,
        ...(session.queue
          ? { queue: session.queue.map((item) => applyStoredChatOutboxScope(item, resolved)) }
          : {}),
      };
    }
    if (nextKey !== key) {
      delete store.sessions[key];
    }
    migrated = true;
  }
  return migrated;
}

export function captureChatOutboxAdmission(
  state: ChatComposerScope,
  sessionKey: string,
  agentId?: string,
) {
  return {
    scope: resolveUiConversationIdentity(state, sessionKey, agentId),
    awaitingDefaults: !hasUiSessionDefaults(state),
  };
}

// Captured scopes never consult current defaults. Fill only an omitted agent;
// explicit conflicting facts must remain visible to stored-scope validation.
function storedChatOutboxAgentId(scope: StoredChatOutboxScope): string | undefined {
  return scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId;
}

export function storedChatOutboxScopeKey(scope: StoredChatOutboxScope): string {
  const normalizedSessionKey = scope.sessionKey.trim().toLowerCase();
  const agentScope =
    storedChatOutboxAgentId(scope) ??
    (normalizedSessionKey === "global" || normalizedSessionKey === DEFAULT_MAIN_KEY
      ? UNRESOLVED_GLOBAL_AGENT_SCOPE
      : DEFAULT_AGENT_ID);
  return `${scope.sessionKey}\u0000agent:${agentScope}`;
}

/** Logical client ownership plus this key fences a retained delivery's display. */
export function chatOutboxDeliveryKey(
  host: ChatComposerScope,
  scope: StoredChatOutboxScope,
  runId = "",
): string {
  return (
    JSON.stringify([
      host.settings?.gatewayUrl,
      host.client?.recoveryScope,
      storedChatOutboxScopeKey(scope),
    ]) + runId
  );
}

function holdComposerRecovery(
  store: StoredComposerState,
  id: string,
  sourceVersion: StoredComposerRecovery["sourceVersion"],
  sourceScopeKey: string,
  session: StoredComposerSession,
): void {
  const { queue, ...draft } = session;
  const groups = new Map<string | undefined, ChatQueueItem[]>();
  if (draft.draft || draft.goalMode || (!queue?.length && draft.draftRevision !== undefined)) {
    groups.set(undefined, []);
  }
  for (const item of queue ?? []) {
    const owner = item.attachmentPayload?.recoveryScope;
    const rows = groups.get(owner) ?? [];
    rows.push(item);
    groups.set(owner, rows);
  }
  for (const [owner, rows] of groups) {
    store.recovery[`${id}:${JSON.stringify(owner ?? null)}`] = {
      sourceVersion,
      sourceScopeKey,
      session: {
        ...(owner === undefined
          ? draft
          : { updatedAt: session.updatedAt, draftRevision: session.draftRevision }),
        ...(rows.length ? { queue: rows } : {}),
      },
    };
  }
}

function migrateComposerRow(
  store: StoredComposerState,
  version: 1 | 2 | 3,
  sourceScopeKey: string,
  session: StoredComposerSession,
  scope: StoredChatOutboxScope | null,
  receipt: string,
): void {
  const key = scope ? storedChatOutboxScopeKey(scope) : sourceScopeKey;
  const conflictingItems = session.queue?.some(
    (item) =>
      (item.sessionKey && item.sessionKey !== scope?.sessionKey) ||
      (item.agentId && item.agentId !== scope?.agentId),
  );
  if (
    scope &&
    !conflictingItems &&
    !store.sessions[key] &&
    Object.keys(store.sessions).length < MAX_STORED_SESSIONS
  ) {
    store.sessions[key] = {
      ...session,
      ...(session.queue ? { queue: session.queue.map((item) => ({ ...item, ...scope })) } : {}),
    };
  } else {
    holdComposerRecovery(
      store,
      `${version}:${receipt}:${sourceScopeKey}`,
      version,
      sourceScopeKey,
      session,
    );
  }
}

export function readStoredOutboxStore(
  storage: Storage,
  target: ComposerStorageTarget,
): StoredComposerState {
  const raw = storage.getItem(target.key);
  const store: StoredComposerState = raw
    ? JSON.parse(raw)
    : {
        version: 4,
        gatewayOwner: target.gatewayOwner,
        sessions: {},
        recovery: {},
      };
  if (raw) {
    if (
      store.version !== 4 ||
      store.gatewayOwner !== target.gatewayOwner ||
      !store.sessions ||
      !store.recovery
    ) {
      throw new Error("Chat outbox owner or version mismatch");
    }
    for (const [key, value] of Object.entries(store.sessions)) {
      const session = normalizeStoredSession(value);
      if (!session) {
        throw new Error("Invalid chat outbox record");
      }
      store.sessions[key] = session;
      observeDraftRevision(session.draftRevision);
      rememberDraftRevision(storage, target.key, key, session.draftRevision);
    }
  }
  const sources: Array<{ key: string; raw: string }> = [];
  for (const [key, version] of [
    [target.blobKey, 3],
    [target.previousKey, 2],
    ...(target.legacyOwnerIsUnambiguous ? [[target.legacyKey, 1] as const] : []),
  ] as const) {
    const legacyRaw = storage.getItem(key);
    if (!legacyRaw) {
      continue;
    }
    const receipt = bytesToHex(sha256(new TextEncoder().encode(legacyRaw)));
    if (store.legacyReceipts?.[version] === receipt) {
      sources.push({ key, raw: legacyRaw });
      continue;
    }
    const legacy = JSON.parse(legacyRaw) as {
      version: number;
      gatewayOwner?: string;
      mainAlias?: { key?: string };
      sessions: Record<string, unknown>;
    };
    if (
      legacy.version !== version ||
      (version !== 1 && legacy.gatewayOwner !== target.gatewayOwner) ||
      !legacy.sessions
    ) {
      throw new Error("Chat outbox legacy owner or version mismatch");
    }
    const previousSessions = { ...store.sessions };
    const previousRecovery = { ...store.recovery };
    for (const [sourceScopeKey, value] of Object.entries(legacy.sessions)) {
      const session = normalizeStoredSession(value);
      const removed =
        isRecord(value) && Array.isArray(value.removedQueueItemIds)
          ? value.removedQueueItemIds
          : [];
      const sourceQueue =
        isRecord(value) && Array.isArray(value.queue)
          ? value.queue.filter((item) => !isRecord(item) || !removed.includes(item.id))
          : [];
      if (!session || sourceQueue.length !== (session.queue?.length ?? 0)) {
        // Do not acknowledge a partial migration or discard unreadable source bytes.
        throw new Error("Invalid legacy chat outbox record");
      }
      const scope = parseStoredChatOutboxScope(sourceScopeKey);
      const identifiable =
        scope &&
        (parseAgentSessionKey(scope.sessionKey) ||
          (version === 1 && scope.sessionKey === "global" && scope.agentId) ||
          (scope.sessionKey !== "global" &&
            scope.sessionKey !== "main" &&
            scope.sessionKey !== legacy.mainAlias?.key));
      // Some pre-consolidation items still carry an independent qualified target.
      // Move those items by their own identity; the bucket's draft remains ambiguous.
      if (!raw && version !== 1 && scope?.sessionKey === "global") {
        const identified = new Map<string, ChatQueueItem[]>();
        session.queue = session.queue?.filter((item) => {
          const parsed = parseAgentSessionKey(item.sessionKey);
          if (!parsed || (item.agentId && item.agentId !== parsed.agentId)) {
            return true;
          }
          const identifiedKey = storedChatOutboxScopeKey({
            sessionKey: item.sessionKey!,
            agentId: parsed.agentId,
          });
          if (
            !identified.has(identifiedKey) &&
            Object.keys(store.sessions).length + identified.size >= MAX_STORED_SESSIONS
          ) {
            return true;
          }
          const rows = identified.get(identifiedKey) ?? [];
          rows.push(item);
          identified.set(identifiedKey, rows);
          return false;
        });
        for (const [identifiedKey, queue] of identified) {
          migrateComposerRow(
            store,
            version,
            `${sourceScopeKey}:${identifiedKey}`,
            { queue, updatedAt: session.updatedAt },
            parseStoredChatOutboxScope(identifiedKey),
            receipt,
          );
        }
      }
      if (
        session.draft ||
        session.goalMode ||
        session.draftRevision !== undefined ||
        session.queue?.length
      ) {
        // A later legacy writer may have already sent an earlier copy. Never
        // auto-replay a downgraded writer's snapshot over current browser state.
        migrateComposerRow(
          store,
          version,
          sourceScopeKey,
          session,
          !raw && identifiable ? scope : null,
          receipt,
        );
      }
    }
    if (Object.keys(store.recovery).length > MAX_RECOVERY_ROWS) {
      // Keep existing recovery usable while the next whole source waits for space.
      store.sessions = previousSessions;
      store.recovery = previousRecovery;
      store.recoveryBlocked = true;
      continue;
    }
    store.legacyReceipts = { ...store.legacyReceipts, [version]: receipt };
    sources.push({ key, raw: legacyRaw });
  }
  if (sources.length) {
    pendingLegacyTransfers.set(store, sources);
    try {
      writeStoredOutboxStore(storage, target, store);
    } catch {
      // The complete source remains readable; no queued entry is lost to quota.
    }
  }
  return store;
}

export function readProjectedOutboxStore(
  storage: Storage,
  target: ComposerStorageTarget,
): StoredComposerState {
  const byKey = projectedStoreByStorage.get(storage);
  const cached = byKey?.get(target.key);
  if (cached) {
    return cached;
  }
  const store = readStoredOutboxStore(storage, target);
  const nextByKey = byKey ?? new Map();
  nextByKey.set(target.key, store);
  projectedStoreByStorage.set(storage, nextByKey);
  return store;
}

export function writeStoredOutboxStore(
  storage: Storage,
  target: ComposerStorageTarget,
  store: StoredComposerState,
): void {
  const previous = storage.getItem(target.key);
  projectedStoreByStorage.get(storage)?.delete(target.key);
  if (Object.keys(store.recovery).length > MAX_RECOVERY_ROWS) {
    throw new Error("Chat outbox recovery limit reached; legacy source retained");
  }
  const entries = Object.entries(store.sessions);
  const outboxes = entries.filter(([, session]) => session.queue?.length);
  if (outboxes.length > MAX_STORED_SESSIONS) {
    throw new Error("Chat outbox session limit reached");
  }
  const drafts = entries.filter(([, session]) => !session.queue?.length);
  const unresolvedGlobalKey = `global\u0000agent:${UNRESOLVED_GLOBAL_AGENT_SCOPE}`;
  const byNewest = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    Number(b[1].awaitingDefaults === true && !parseAgentSessionKey(b[0])) -
      Number(a[1].awaitingDefaults === true && !parseAgentSessionKey(a[0])) ||
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
  if (
    retained.length === 0 &&
    Object.keys(store.recovery).length === 0 &&
    !pendingLegacyTransfers.has(store) &&
    !store.legacyReceipts
  ) {
    storage.removeItem(target.key);
    if (storage.getItem(target.key) !== null) {
      throw new Error("Chat outbox removal verification failed");
    }
    retireRemovedOutboxPayloads(storage, target, previous, null);
    return;
  }
  if (pendingLegacyTransfers.has(store) && retained.length < entries.length) {
    throw new Error("Chat outbox migration exceeds retention; source retained");
  }
  const retainedStore: StoredComposerState = {
    version: 4,
    gatewayOwner: target.gatewayOwner,
    sessions: Object.fromEntries(retained),
    recovery: store.recovery,
    ...(store.legacyReceipts ? { legacyReceipts: store.legacyReceipts } : {}),
  };
  const payload = JSON.stringify(retainedStore);
  // Verification precedes deleting any legacy source, including quota/no-op writes.
  storage.setItem(target.key, payload);
  if (storage.getItem(target.key) !== payload) {
    throw new Error("Chat outbox write verification failed");
  }
  for (const source of pendingLegacyTransfers.get(store) ?? []) {
    if (storage.getItem(source.key) === source.raw) {
      try {
        storage.removeItem(source.key);
      } catch {
        // The verified receipt fences this exact source even if deletion fails.
      }
    }
  }
  pendingLegacyTransfers.delete(store);
  retireRemovedOutboxPayloads(storage, target, previous, retainedStore);
}

// Cleanup follows a verified metadata commit, never a credential-filtered view.
function retireRemovedOutboxPayloads(
  storage: Storage,
  target: ComposerStorageTarget,
  previous: string | null,
  current: StoredComposerState | null,
): void {
  if (!previous) {
    return;
  }
  try {
    // An unclassified, deferred, or undeletable source can still own these bytes.
    // Keep bounded orphans rather than introduce a second garbage-collection store.
    if (
      [target.legacyKey, target.previousKey, target.blobKey].some(
        (key) => storage.getItem(key) !== null,
      )
    ) {
      return;
    }
    const references = (value: unknown) => {
      if (value === null) {
        return [];
      }
      if (
        !isRecord(value) ||
        value.version !== 4 ||
        value.gatewayOwner !== target.gatewayOwner ||
        !isRecord(value.sessions) ||
        !isRecord(value.recovery)
      ) {
        throw new Error("Unreadable outbox retention source");
      }
      const rows = [
        ...Object.values(value.sessions),
        ...Object.values(value.recovery).map((entry) => {
          if (!isRecord(entry)) {
            throw new Error("Unreadable recovery source");
          }
          return entry.session;
        }),
      ];
      return rows.flatMap((row) => {
        if (!isRecord(row) || (row.queue !== undefined && !Array.isArray(row.queue))) {
          throw new Error("Unreadable outbox row");
        }
        return (row.queue ?? []).flatMap((item: unknown) => {
          if (!isRecord(item)) {
            throw new Error("Unreadable outbox item");
          }
          const ref = item.attachmentPayload;
          if (ref === undefined) {
            return [];
          }
          if (
            !isRecord(ref) ||
            typeof ref.key !== "string" ||
            typeof ref.recoveryScope !== "string" ||
            typeof ref.tabId !== "string"
          ) {
            throw new Error("Unreadable outbox payload reference");
          }
          return [{ key: ref.key, recoveryScope: ref.recoveryScope, tabId: ref.tabId }];
        });
      });
    };
    const remaining = new Set(references(current).map((ref) => ref.key));
    const removed = references(JSON.parse(previous)).filter((ref) => !remaining.has(ref.key));
    if (removed.length) {
      void removeOutboxPayloads(removed);
    }
  } catch {
    // Missing/unreadable storage cannot authorize deletion; the Blob budget bounds retention.
  }
}

export function applyStoredChatOutboxScope(
  item: ChatQueueItem,
  scope: StoredChatOutboxScope,
): ChatQueueItem {
  const { agentId: _agentId, ...withoutAgentId } = item;
  const agentId = storedChatOutboxAgentId(scope);
  return {
    ...withoutAgentId,
    sessionKey: scope.sessionKey,
    ...(agentId ? { agentId } : {}),
  };
}
