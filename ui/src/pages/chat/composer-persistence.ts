import type {
  ChatAttachment,
  ChatComposerDraftRetry,
  ChatQueueItem,
} from "../../lib/chat/chat-types.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  MAX_STORED_QUEUE_ITEMS,
  normalizeStoredQueueItem,
  normalizeStoredSession,
  type StoredComposerSession,
} from "../../lib/chat/outbox-store-codec.ts";
import {
  nextDraftRevision,
  rememberDraftAttempt,
  rememberDraftRevision,
  rememberedDraftAttempt,
  rememberedDraftRevision,
} from "../../lib/chat/outbox-store-draft-state.ts";
import {
  applyStoredChatOutboxScope,
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore as readStore,
  resolveComposerStorageScope,
  resolveStoredComposerSession,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  UNRESOLVED_GLOBAL_AGENT_SCOPE,
  writeStoredOutboxStore as writeStore,
  type ChatComposerScope,
  type ComposerStorageScope,
  type StoredChatOutboxScope,
  type StoredComposerState,
} from "../../lib/chat/outbox-store.ts";
// Control UI chat module implements composer persistence behavior.
import { getSafeSessionStorage } from "../../local-storage.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  captureDurableChatAttachments,
  chatAttachmentDraftSignature,
  DurableChatComposerPersistence,
  durableComposerScopeIdentity,
  type DurableChatComposerSnapshot,
} from "./durable-composer-persistence.ts";

const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;
export const CHAT_COMPOSER_DRAFT_STORAGE_ERROR =
  "Could not store the previous draft in browser storage. It remains available in this tab.";

export { INTERRUPTED_SETTINGS_WAIT_ERROR } from "../../lib/chat/outbox-store-codec.ts";
export {
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
export { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
export type { ChatComposerScope, StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
export type { StoredChatOutbox } from "../../lib/chat/outbox-store-projection.ts";

type ChatComposerPersistenceState = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: {
    snapshot?: unknown;
  } | null;
  sessionKey: string;
  chatMessage: string;
  chatAttachments?: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  client?: { recoveryScope?: string; recoveryScopeReady?: boolean } | null;
  connected?: boolean;
  lastError?: string | null;
  chatError?: string | null;
  requestUpdate?: () => void;
};

type DurableChatComposerPersistenceState = ChatComposerPersistenceState & {
  selectedChatSessionIncognito: boolean;
};

type RestoreOptions = {
  preserveCurrent?: boolean;
  sessionKey?: string;
};

export type { ChatComposerDraftRetry } from "../../lib/chat/chat-types.ts";

type ChatComposerPersistStatus = "persisted" | "conflict" | "storage-failed";

export type ChatComposerPersistResult =
  | { status: "persisted" }
  | { status: "conflict" }
  | ({ status: "storage-failed" } & ChatComposerDraftRetry);

export type StoredChatQueueReplacement = {
  id: string;
  expected: ChatQueueItem;
};

type ChatComposerPersistOptions = {
  agentId?: string;
  draft?: string;
  draftRevision?: number;
  expectedDraftRevision?: number;
};

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

function serializeQueueItem(item: ChatQueueItem): ChatQueueItem | null {
  if (
    item.skillWorkshopRevision ||
    !item.id?.trim() ||
    (!item.text?.trim() && !item.attachments?.length) ||
    item.pendingRunId ||
    (item.sendState === "sending" && !item.sendRunId)
  ) {
    return null;
  }
  const attachments = item.attachments?.map(serializeChatAttachment) ?? [];
  if (item.attachments?.length && attachments.some((attachment) => attachment === null)) {
    return null;
  }
  const sendState =
    item.sendState === "sending"
      ? "waiting-reconnect"
      : item.sendState === "executing-command"
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
  return normalizeStoredQueueItem({
    ...item,
    attachments: attachments.length ? attachments : undefined,
    ...(sendState ? { sendState } : {}),
    ...(sendError ? { sendError } : {}),
  });
}

function serializeQueueItemForScope(
  item: ChatQueueItem,
  scope: ComposerStorageScope,
): ChatQueueItem | null {
  const serialized = serializeQueueItem(item);
  if (!serialized) {
    return null;
  }
  return applyStoredChatOutboxScope(serialized, scope);
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
    stored.sessionKey === canonicalExpected.sessionKey &&
    stored.orderKey === canonicalExpected.orderKey,
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
      // Notify only on presence transitions: sidebar draft indicators consume
      // presence, and content-only notifies would let projection subscribers
      // re-persist a stale pane over a newer draft (route-fallback invariant).
      if (Boolean(storedDraft) !== Boolean(draft)) {
        notifyStoredChatOutboxChanges();
      }
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
  replaces?: StoredChatQueueReplacement,
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
    // An edited row and its replacement are one write: the source is retired only
    // by the write that stores the replacement, so a rejected write leaves the
    // original queued instead of losing both copies. Filtering before the cap
    // check also keeps a replacement admissible on a full queue.
    const storedQueue = session?.queue ?? [];
    if (
      replaces &&
      !storedQueue.some(
        (entry) =>
          entry.id === replaces.id && queueItemVersionMatches(entry, replaces.expected, scope),
      )
    ) {
      return false;
    }
    const queue = storedQueue.filter((entry) => entry.id !== replaces?.id);
    const existing = queue.find((entry) => entry.id === serialized.id);
    if (existing) {
      if (!queueItemsEqual(existing, serialized, scope)) {
        return false;
      }
      if (migrated) {
        writeStore(storage, target, store);
        notifyStoredChatOutboxChanges();
      }
      return true;
    }
    if (queue.length >= MAX_STORED_QUEUE_ITEMS) {
      return false;
    }
    writeStoredComposerSession(store, storeSessionKey, session, [...queue, serialized]);
    writeStore(storage, target, store);
    notifyStoredChatOutboxChanges();
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

/**
 * Batch compare-and-set for durable queue rows. A caller passing several rows
 * (a reorder permutation) gets one fresh read, one validation pass over every
 * expected row, one full-document write, and one read-back verification — so
 * the whole set commits or none of it does. A mid-batch storage failure can
 * never leave a permutation half-applied the way a per-row write loop would.
 */
export function updateStoredChatComposerQueueItems(
  state: ChatComposerScope,
  sessionKey: string,
  updates: readonly { expected: ChatQueueItem; next: ChatQueueItem }[],
  agentId?: string,
): boolean {
  if (updates.length === 0) {
    return true;
  }
  const storage = getSafeSessionStorage();
  if (
    !storage ||
    !sessionKey.trim() ||
    updates.some(({ expected, next }) => expected.id !== next.id)
  ) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = resolveComposerStorageScope(
      state,
      sessionKey,
      agentId ?? updates[0]!.expected.agentId ?? updates[0]!.next.agentId,
      store.mainAlias,
    );
    const { session, storeSessionKey } = resolveStoredComposerSession(
      store,
      state,
      sessionKey,
      scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
    );
    const nextQueue = (session?.queue ?? []).slice();
    for (const { expected, next } of updates) {
      const index = nextQueue.findIndex((entry) => entry.id === expected.id);
      const stored = index >= 0 ? nextQueue[index] : undefined;
      const serializedNext =
        stored && queueItemVersionMatches(stored, expected, scope)
          ? serializeQueueItemForScope(next, scope)
          : null;
      if (!serializedNext) {
        // A missing or stale row rejects the whole batch before anything is written.
        return false;
      }
      nextQueue[index] = serializedNext;
    }
    writeStoredComposerSession(store, storeSessionKey, session, nextQueue);
    writeStore(storage, target, store);
    notifyStoredChatOutboxChanges();
    const persistedQueue =
      resolveStoredComposerSession(
        readStore(storage, target),
        state,
        sessionKey,
        scope.agentScope === UNRESOLVED_GLOBAL_AGENT_SCOPE ? undefined : scope.agentScope,
      ).session?.queue ?? [];
    return updates.every(({ next }) => {
      const serializedNext = serializeQueueItemForScope(next, scope);
      const persisted = persistedQueue.find((entry) => entry.id === next.id);
      return Boolean(
        persisted && serializedNext && queueItemsEqual(persisted, serializedNext, scope),
      );
    });
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
  return updateStoredChatComposerQueueItems(state, sessionKey, [{ expected, next }], agentId);
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
    notifyStoredChatOutboxChanges();
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
  attachments: ChatAttachment[];
  durable?: DurableChatComposerSnapshot;
};

export class ChatComposerPersistence {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ready = false;
  private pending: ChatComposerDraftSnapshot | null = null;
  private lastPersisted: ChatComposerDraftSnapshot | null = null;
  private committedDraftRevision = 0;
  private latestDraftRevision = 0;
  private durableRestoreProtected = false;
  private durableOwnerKey = "";
  private durableRetiredScopeKey = "";
  private forceDurableOwnerRestore = false;
  private readonly durablePersistence = new DurableChatComposerPersistence(
    () => {
      const state = this.getState();
      if (!state) {
        return;
      }
      state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.requestUpdate?.();
    },
    () => this.getState()?.requestUpdate?.(),
  );

  constructor(private readonly getState: () => DurableChatComposerPersistenceState | undefined) {}

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
    const stored = loadChatComposerSnapshot(state, state.sessionKey);
    this.durableRestoreProtected =
      (state.chatAttachments?.length ?? 0) > 0 || (stored?.draft ?? "") !== state.chatMessage;
    this.durablePersistence.resetRestoreScope();
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
    this.synchronizeDurablePersistence();
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
    this.durableRestoreProtected = false;
    this.durablePersistence.resetRestoreScope();
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
      if (
        chatAttachmentDraftSignature(this.pending.chatMessage, this.pending.attachments) ===
        chatAttachmentDraftSignature(current.chatMessage, current.attachments)
      ) {
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
    this.synchronizeDurablePersistence();
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
      if (!baseline.chatMessage && baseline.attachments.length === 0) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      const revisions = this.readDraftRevisions(state, baseline.sessionKey, baseline.agentId);
      const storedRevision = revisions.committed;
      const stored = loadChatComposerSnapshot(state, baseline.sessionKey, baseline.agentId);
      if (
        baseline.attachments.length === 0 &&
        storedRevision === baseline.draftRevision &&
        stored?.draft === baseline.chatMessage
      ) {
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
    this.durableRestoreProtected = false;
    this.durablePersistence.resetRestoreScope();
  }

  private persistSnapshot(
    state: DurableChatComposerPersistenceState,
    snapshot: ChatComposerDraftSnapshot,
    enforceExpectedRevision = false,
  ): ChatComposerPersistResult {
    const status = persistChatComposerStateResult(state, snapshot.sessionKey, {
      agentId: snapshot.agentId,
      draft: snapshot.chatMessage,
      draftRevision: snapshot.draftRevision,
      ...(enforceExpectedRevision ? { expectedDraftRevision: snapshot.expectedDraftRevision } : {}),
    });
    if (snapshot.durable) {
      this.durablePersistence.persist(snapshot.durable);
    }
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
      last &&
      last.sessionKey === snapshot.sessionKey &&
      chatAttachmentDraftSignature(last.chatMessage, last.attachments) ===
        chatAttachmentDraftSignature(snapshot.chatMessage, snapshot.attachments),
    );
  }

  private snapshot(
    state: DurableChatComposerPersistenceState,
    draftRevision: number = this.latestDraftRevision,
    expectedDraftRevision: number = this.committedDraftRevision,
  ): ChatComposerDraftSnapshot {
    const scope = resolveStoredChatOutboxScope(state, state.sessionKey);
    const durableScope = this.resolveDurableScope(state, scope);
    const attachments = (state.chatAttachments ?? []).map((attachment) =>
      Object.assign(
        {},
        attachment,
        attachment.browserAnnotation
          ? { browserAnnotation: Object.assign({}, attachment.browserAnnotation) }
          : {},
      ),
    );
    const durable = durableScope
      ? {
          scope: durableScope,
          expectedRevision: expectedDraftRevision,
          revision: draftRevision,
          text: state.chatMessage,
          attachments,
          storedAttachments: captureDurableChatAttachments(attachments),
          writeId: `${draftRevision}:${Math.random().toString(36).slice(2)}`,
        }
      : undefined;
    return {
      sessionKey: state.sessionKey,
      chatMessage: state.chatMessage,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      expectedDraftRevision,
      draftRevision,
      attachments,
      ...(durable ? { durable } : {}),
    };
  }

  private resolveDurableScope(
    state: DurableChatComposerPersistenceState,
    scope: StoredChatOutboxScope = resolveStoredChatOutboxScope(state, state.sessionKey),
  ) {
    if (state.selectedChatSessionIncognito) {
      return null;
    }
    return this.resolveConnectedDurableScope(state, scope);
  }

  private resolveConnectedDurableScope(
    state: DurableChatComposerPersistenceState,
    scope: StoredChatOutboxScope = resolveStoredChatOutboxScope(state, state.sessionKey),
  ) {
    const recoveryScope = state.client?.recoveryScope?.trim();
    if (!state.connected || !state.client?.recoveryScopeReady || !recoveryScope) {
      return null;
    }
    return {
      gatewayOwner: storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner,
      recoveryScope,
      scopeKey: storedChatOutboxScopeKey(scope),
    };
  }

  private synchronizeDurablePersistence() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    const connectedScope = this.resolveConnectedDurableScope(state);
    if (state.selectedChatSessionIncognito) {
      if (connectedScope) {
        const scopeKey = durableComposerScopeIdentity(connectedScope);
        if (this.durableRetiredScopeKey !== scopeKey) {
          this.durableRetiredScopeKey = scopeKey;
          this.durableOwnerKey = "";
          this.forceDurableOwnerRestore = false;
          this.durableRestoreProtected = false;
          this.durablePersistence.retire(connectedScope, this.latestDraftRevision);
        }
      }
      return;
    }
    this.durableRetiredScopeKey = "";
    const scope = connectedScope;
    if (!scope) {
      return;
    }
    const ownerKey = JSON.stringify([scope.gatewayOwner, scope.recoveryScope]);
    if (this.durableOwnerKey && this.durableOwnerKey !== ownerKey) {
      releaseChatAttachmentPayloads(state.chatAttachments);
      state.chatMessage = "";
      state.chatAttachments = [];
      this.pending = null;
      const revisions = this.readDraftRevisions(state);
      this.committedDraftRevision = revisions.committed;
      this.latestDraftRevision = nextDraftRevision(revisions.latestAttempt);
      persistChatComposerStateResult(state, state.sessionKey, {
        draft: "",
        draftRevision: this.latestDraftRevision,
      });
      this.committedDraftRevision = this.latestDraftRevision;
      this.lastPersisted = this.snapshot(state, this.latestDraftRevision, this.latestDraftRevision);
      this.durableRestoreProtected = false;
      this.forceDurableOwnerRestore = true;
      this.durablePersistence.resetRestoreScope();
      state.requestUpdate?.();
    }
    this.durableOwnerKey = ownerKey;
    if (this.durableRestoreProtected) {
      this.durableRestoreProtected = false;
      const snapshot = this.snapshot(
        state,
        nextDraftRevision(this.latestDraftRevision),
        this.committedDraftRevision,
      );
      this.latestDraftRevision = snapshot.draftRevision;
      this.persistSnapshot(state, snapshot);
      return;
    }
    const baseline = this.snapshot(state, this.latestDraftRevision, this.committedDraftRevision);
    const restoreRevision = this.forceDurableOwnerRestore ? 0 : this.latestDraftRevision;
    this.durablePersistence.restore(
      {
        scope,
        committedRevision: this.committedDraftRevision,
        latestRevision: restoreRevision,
        signature: chatAttachmentDraftSignature(state.chatMessage, state.chatAttachments ?? []),
      },
      () => ({
        scope: this.resolveDurableScope(state),
        signature: chatAttachmentDraftSignature(state.chatMessage, state.chatAttachments ?? []),
        revision: this.forceDurableOwnerRestore ? 0 : this.latestDraftRevision,
      }),
      (draft) => {
        const forceOwnerRestore = this.forceDurableOwnerRestore;
        this.forceDurableOwnerRestore = false;
        const displaced = state.chatAttachments ?? [];
        state.chatMessage = draft.text;
        state.chatAttachments = draft.attachments;
        releaseChatAttachmentPayloads(displaced);
        const adoptedRevision = forceOwnerRestore
          ? nextDraftRevision(Math.max(this.latestDraftRevision, draft.revision))
          : draft.revision;
        persistChatComposerStateResult(state, state.sessionKey, {
          agentId: resolveStoredChatOutboxScope(state, state.sessionKey).agentId,
          draft: draft.text,
          draftRevision: adoptedRevision,
        });
        this.committedDraftRevision = adoptedRevision;
        this.latestDraftRevision = adoptedRevision;
        this.lastPersisted = this.snapshot(state, adoptedRevision, adoptedRevision);
        if (forceOwnerRestore && this.lastPersisted.durable) {
          this.durablePersistence.persist({
            ...this.lastPersisted.durable,
            expectedRevision: draft.revision,
          });
        }
        state.requestUpdate?.();
      },
      (storedRevision) => {
        this.forceDurableOwnerRestore = false;
        if (baseline.durable && (state.chatMessage || (state.chatAttachments?.length ?? 0) > 0)) {
          this.durablePersistence.persist({
            ...baseline.durable,
            expectedRevision: storedRevision,
          });
        }
      },
    );
  }

  private readDraftRevisions(
    state: DurableChatComposerPersistenceState,
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
