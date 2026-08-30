import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getSafeSessionStorage } from "../../local-storage.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  parseAgentSessionKey,
  hasUiSessionDefaults,
  resolveUiConversationIdentity,
} from "../sessions/session-key.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import {
  MAX_STORED_SESSIONS,
  normalizeStoredSession,
  type StoredComposerSession,
} from "./outbox-store-codec.ts";
import {
  nextDraftRevision,
  observeDraftRevision,
  rememberedDraftAttempt,
  rememberedDraftRevision,
  rememberDraftAttempt,
  rememberDraftRevision,
} from "./outbox-store-draft-state.ts";

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const PREVIOUS_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v2:";
const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v3:";
const UNRESOLVED_GLOBAL_AGENT_SCOPE = "@unresolved";
const storedChatOutboxChangeListeners = new Set<() => void>();
let storageChangeListenerInstalled = false;

export type ChatComposerScope = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null; scope?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

type ComposerStorageTarget = {
  key: string;
  legacyKey: string;
  previousKey: string;
  gatewayOwner: string;
  legacyOwnerIsUnambiguous: boolean;
};

export type StoredChatOutboxScope = {
  sessionKey: string;
  agentId?: string;
};

type StoredComposerRetirementTarget = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

type StoredComposerRetirement = {
  scope: StoredChatOutboxScope;
  minimumRevision: number;
  retireBeforeRevision: number;
};

export type StoredComposerState = {
  version: 3;
  gatewayOwner: string;
  sessions: Record<string, StoredComposerSession>;
  recovery: Record<string, StoredComposerRecovery>;
  legacyReceipts?: Partial<Record<"1" | "2", string>>;
  recoveryBlocked?: true;
};

export type StoredComposerRecovery = {
  sourceVersion: 1 | 2 | 3;
  sourceScopeKey: string;
  session: StoredComposerSession;
};

// Two legacy versions can each contain 20 live rows and 20 clear fences.
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
    event.key?.startsWith(PREVIOUS_STORAGE_KEY_PREFIX)
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
    const resolved = resolveStoredChatOutboxScope(state, source.sessionKey, source.agentId);
    const nextKey = storedChatOutboxScopeKey(resolved);
    const { awaitingDefaults: _, ...session } = pending;
    const destination = store.sessions[nextKey];
    if (nextKey !== key && destination) {
      const existingIds = new Set(destination.queue?.map((item) => item.id));
      const conflict = session.queue?.some((item) => existingIds.has(item.id));
      const sourceNewer = (session.draftRevision ?? 0) > (destination.draftRevision ?? 0);
      if (conflict || (session.draft && !sourceNewer)) {
        store.recovery[`pending:${key}`] = { sourceVersion: 3, sourceScopeKey: key, session };
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

export function resolveStoredChatOutboxScope(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): StoredChatOutboxScope {
  return resolveUiConversationIdentity(state, sessionKey, agentIdOverride);
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

function migrateComposerRow(
  store: StoredComposerState,
  version: 1 | 2,
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
    store.recovery[`${version}:${receipt}:${sourceScopeKey}`] = {
      sourceVersion: version,
      sourceScopeKey,
      session,
    };
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
        version: 3,
        gatewayOwner: target.gatewayOwner,
        sessions: {},
        recovery: {},
      };
  if (raw) {
    if (
      store.version !== 3 ||
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
      (version === 2 && legacy.gatewayOwner !== target.gatewayOwner) ||
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
      if (!raw && version === 2 && scope?.sessionKey === "global") {
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
          identified.set(identifiedKey, [...(identified.get(identifiedKey) ?? []), item]);
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
    return;
  }
  if (pendingLegacyTransfers.has(store) && retained.length < entries.length) {
    throw new Error("Chat outbox migration exceeds retention; source retained");
  }
  const payload = JSON.stringify({
    version: 3,
    gatewayOwner: target.gatewayOwner,
    sessions: Object.fromEntries(retained),
    recovery: store.recovery,
    ...(store.legacyReceipts ? { legacyReceipts: store.legacyReceipts } : {}),
  });
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
}

export function retireStoredComposerDrafts(
  state: ChatComposerScope,
  targets: readonly StoredComposerRetirementTarget[],
) {
  const storageTarget = storageTargetForGateway(state.settings?.gatewayUrl);
  if (targets.length === 0) {
    return { gatewayOwner: storageTarget.gatewayOwner, retirements: [], storageFailed: false };
  }
  const storage = getSafeSessionStorage();
  if (!storage) {
    return {
      gatewayOwner: storageTarget.gatewayOwner,
      retirements: targets.flatMap((target) => {
        if (!target.key.trim()) {
          return [];
        }
        return [
          {
            scope: resolveStoredChatOutboxScope(state, target.key, target.agentId),
            minimumRevision: target.retireBeforeRevision,
            retireBeforeRevision: target.retireBeforeRevision,
          },
        ];
      }),
      storageFailed: true,
    };
  }

  const retirements: StoredComposerRetirement[] = [];
  const written: Array<{ storeSessionKey: string; revision: number }> = [];
  let visibleChanged = false;
  try {
    const store = readStoredOutboxStore(storage, storageTarget);
    let changed = resolvePendingComposerSessions(store, state);
    for (const target of targets) {
      if (!target.key.trim()) {
        return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: true };
      }
      const scope = resolveStoredChatOutboxScope(state, target.key, target.agentId);
      const storeSessionKey = storedChatOutboxScopeKey(scope);
      const session = store.sessions[storeSessionKey];
      const storedRevision = session?.draftRevision ?? 0;
      const currentRevision = Math.max(
        storedRevision,
        rememberedDraftRevision(storage, storageTarget.key, storeSessionKey),
        rememberedDraftAttempt(storage, storageTarget.key, storeSessionKey),
      );
      let minimumRevision = target.retireBeforeRevision;
      if (storedRevision < target.retireBeforeRevision) {
        minimumRevision = nextDraftRevision(Math.max(currentRevision, target.retireBeforeRevision));
        rememberDraftAttempt(storage, storageTarget.key, storeSessionKey, minimumRevision);
        visibleChanged ||= Boolean(session?.draft) || Boolean(session?.queue?.length);
        store.sessions[storeSessionKey] = {
          draftRevision: minimumRevision,
          updatedAt: Date.now(),
        };
        written.push({
          storeSessionKey,
          revision: minimumRevision,
        });
        changed = true;
      }
      retirements.push({
        scope,
        minimumRevision,
        retireBeforeRevision: target.retireBeforeRevision,
      });
    }
    if (!changed) {
      return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: false };
    }
    writeStoredOutboxStore(storage, storageTarget, store);
    const persisted = readStoredOutboxStore(storage, storageTarget);
    for (const { storeSessionKey, revision } of written) {
      const session = normalizeStoredSession(persisted.sessions[storeSessionKey]);
      if (
        session?.draftRevision !== revision ||
        Boolean(session.draft) ||
        Boolean(session.queue?.length)
      ) {
        return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: true };
      }
      rememberDraftRevision(storage, storageTarget.key, storeSessionKey, revision);
    }
    if (visibleChanged) {
      notifyStoredChatOutboxChanges();
    }
    return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: false };
  } catch {
    return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: true };
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
