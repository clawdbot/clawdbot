import type {
  ChatAttachment,
  ChatComposerDraftRetry,
  ChatGoalDraftMode,
  ChatQueueItem,
} from "../../lib/chat/chat-types.ts";
import { outboxPayloadMatchesOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  MAX_STORED_QUEUE_ITEMS,
  normalizeStoredQueueItem,
  sameQueuedDeliveryVersion,
  type StoredComposerSession,
} from "../../lib/chat/outbox-store-codec.ts";
import {
  nextDraftRevision,
  rememberDraftAttempt,
  rememberDraftRevision,
  readDraftRevisionState,
} from "../../lib/chat/outbox-store-draft-state.ts";
import {
  applyStoredChatOutboxScope,
  captureChatOutboxAdmission,
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore as readStore,
  resolvePendingComposerSessions,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  writeStoredOutboxStore as writeStore,
  type ChatComposerScope,
  type StoredChatOutboxScope,
  type StoredComposerState,
} from "../../lib/chat/outbox-store.ts";
import {
  resolveUiConversationIdentity,
  hasUiSessionDefaults,
} from "../../lib/sessions/session-key.ts";
// Control UI chat module implements composer persistence behavior.
import { getSafeSessionStorage } from "../../local-storage.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { normalizeChatComposerDraft } from "./composer-draft.ts";
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
export { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
export { listStoredChatOutboxes } from "../../lib/chat/outbox-store-projection.ts";
export type { ChatComposerScope, StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
export type { StoredChatOutbox } from "../../lib/chat/outbox-store-projection.ts";

type ChatComposerPersistenceState = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null; scope?: string | null } | null;
  hello?: {
    snapshot?: unknown;
  } | null;
  sessionKey: string;
  chatMessage: string;
  chatGoalDraftMode?: ChatGoalDraftMode | null;
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
  goalMode?: ChatGoalDraftMode | null;
  draftRevision?: number;
  expectedDraftRevision?: number;
};

function serializeQueueItem(item: ChatQueueItem): ChatQueueItem | null {
  if (
    !item.id?.trim() ||
    (!item.text?.trim() &&
      !item.attachments?.length &&
      !item.attachmentPayload &&
      !item.attachmentStorageError) ||
    item.pendingRunId ||
    (item.sendState === "sending" && !item.sendRunId)
  ) {
    return null;
  }
  const attachments = (item.attachments ?? []).map((attachment) => {
    const { dataUrl: _dataUrl, previewUrl: _previewUrl, ...metadata } = attachment;
    // A failed migration owns no Blob yet: retain its inline bytes across reload.
    // Only a payload reference permits removing bytes from the stored queue row.
    if (item.attachmentPayload) {
      return metadata;
    }
    const dataUrl = getChatAttachmentDataUrl(attachment);
    if (dataUrl) {
      return Object.assign(metadata, { dataUrl });
    }
    return item.attachmentStorageError ? metadata : null;
  });
  if (item.attachments?.length && attachments.some((attachment) => attachment === null)) {
    return null;
  }
  return normalizeStoredQueueItem({
    ...item,
    attachments: attachments.length ? attachments : undefined,
    ...(item.sendState === "waiting-model" ? { sendError: INTERRUPTED_SETTINGS_WAIT_ERROR } : {}),
  });
}

function serializeQueueItemForScope(
  item: ChatQueueItem,
  scope: StoredChatOutboxScope,
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
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalExpected = serializeQueueItemForScope(expected, scope);
  return Boolean(canonicalExpected && sameQueuedDeliveryVersion(stored, canonicalExpected));
}

function queueItemsEqual(
  stored: ChatQueueItem,
  canonicalExpected: ChatQueueItem,
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalStored = serializeQueueItemForScope(stored, scope);
  return Boolean(
    canonicalStored && JSON.stringify(canonicalStored) === JSON.stringify(canonicalExpected),
  );
}

function writeStoredComposerSession(
  store: StoredComposerState,
  storeSessionKey: string,
  session: StoredComposerSession | null,
  queue: ChatQueueItem[],
): void {
  if (
    !session?.draft &&
    !session?.goalMode &&
    session?.draftRevision === undefined &&
    queue.length === 0
  ) {
    delete store.sessions[storeSessionKey];
    return;
  }
  store.sessions[storeSessionKey] = {
    ...(session?.awaitingDefaults ? { awaitingDefaults: true } : {}),
    ...(session?.draft ? { draft: session.draft } : {}),
    ...(session?.goalMode ? { goalMode: session.goalMode } : {}),
    ...(session?.draftRevision !== undefined ? { draftRevision: session.draftRevision } : {}),
    ...(queue.length ? { queue } : {}),
    updatedAt: Date.now(),
  };
}

type ChatComposerDraftRevisionState = ReturnType<typeof readDraftRevisionState>;

export function loadChatComposerDraftRevision(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): number {
  return loadCapturedChatComposerState(
    state,
    resolveUiConversationIdentity(state, sessionKey, agentIdOverride),
  ).revisions.latestAttempt;
}

export function loadChatComposerCommittedDraftRevision(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): number {
  return loadCapturedChatComposerState(
    state,
    resolveUiConversationIdentity(state, sessionKey, agentIdOverride),
  ).revisions.committed;
}

export function loadChatComposerSnapshot(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): { draft: string; goalMode?: ChatGoalDraftMode; queue: ChatQueueItem[] } | null {
  return loadCapturedChatComposerState(
    state,
    resolveUiConversationIdentity(state, sessionKey, agentIdOverride),
  ).snapshot;
}

function loadCapturedChatComposerState(
  state: ChatComposerScope,
  captured: StoredChatOutboxScope,
): {
  snapshot: { draft: string; goalMode?: ChatGoalDraftMode; queue: ChatQueueItem[] } | null;
  revisions: ChatComposerDraftRevisionState;
} {
  const empty = { snapshot: null, revisions: { committed: 0, latestAttempt: 0 } };
  const storage = getSafeSessionStorage();
  if (!storage) {
    return empty;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const migrated = resolvePendingComposerSessions(store, state);
    if (migrated) {
      try {
        writeStore(storage, target, store);
      } catch {
        // Migration persistence is best-effort; readable drafts and outboxes remain usable.
      }
    }
    const scopeKey = storedChatOutboxScopeKey(captured);
    const session = store.sessions[scopeKey];
    rememberDraftRevision(storage, target.key, scopeKey, session?.draftRevision);
    const revisions = readDraftRevisionState(storage, target.key, scopeKey, session?.draftRevision);
    const draft = normalizeChatComposerDraft(session?.draft ?? "");
    if (!session || (!draft && !session.goalMode && !session.queue?.length)) {
      return { snapshot: null, revisions };
    }
    return {
      revisions,
      snapshot: {
        draft,
        ...(session.goalMode ? { goalMode: session.goalMode } : {}),
        queue: (session.queue ?? [])
          .filter((item) => outboxPayloadMatchesOwner(state, item))
          .map((item) => serializeQueueItemForScope(item, captured))
          .filter((item): item is ChatQueueItem => item !== null),
      },
    };
  } catch {
    return empty;
  }
}

function persistChatComposerStateResult(
  state: ChatComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): ChatComposerPersistStatus {
  return persistCapturedChatComposerStateResult(
    state,
    captureChatOutboxAdmission(state, sessionKey, options.agentId),
    options,
  );
}

function persistCapturedChatComposerStateResult(
  state: ChatComposerPersistenceState,
  captured: { scope: StoredChatOutboxScope; awaitingDefaults: boolean },
  options: ChatComposerPersistOptions = {},
): ChatComposerPersistStatus {
  const storage = getSafeSessionStorage();
  if (!storage || !captured.scope.sessionKey.trim()) {
    return "storage-failed";
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const storeSessionKey = storedChatOutboxScopeKey(captured.scope);
    const session = store.sessions[storeSessionKey] ?? null;
    const draft = normalizeChatComposerDraft(
      Object.hasOwn(options, "draft") ? (options.draft ?? "") : state.chatMessage,
    );
    const goalMode = Object.hasOwn(options, "goalMode")
      ? options.goalMode
      : state.chatGoalDraftMode;
    const storedDraftRevision = session?.draftRevision;
    rememberDraftRevision(storage, target.key, storeSessionKey, storedDraftRevision);
    // Draft-only rows are bounded and may evict a clear tombstone. Retain the
    // seen revision while this tab is alive so an older failed write cannot
    // treat an evicted scope as revision zero and resurrect stale input.
    const { committed: committedDraftRevision, latestAttempt: newestDraftAttempt } =
      readDraftRevisionState(storage, target.key, storeSessionKey, storedDraftRevision);
    const draftRevision = options.draftRevision ?? nextDraftRevision(newestDraftAttempt);
    if (!Number.isSafeInteger(draftRevision) || draftRevision <= 0) {
      return "conflict";
    }
    const storedDraft = normalizeChatComposerDraft(session?.draft ?? "");
    // Draft interpretation shares the text revision; a retry cannot turn an objective into a command.
    const sameDraft =
      storedDraft === draft &&
      JSON.stringify(session?.goalMode ?? null) === JSON.stringify(goalMode ?? null);
    const expectedDraftRevision = options.expectedDraftRevision;
    const committedMatchesExpected =
      expectedDraftRevision === undefined ||
      committedDraftRevision === expectedDraftRevision ||
      (storedDraftRevision === draftRevision && sameDraft);
    // Reserve every accepted attempt before touching storage. A newer failed
    // edit or clear must fence out older pane fallbacks when capacity recovers.
    if (
      !committedMatchesExpected ||
      draftRevision < newestDraftAttempt ||
      (storedDraftRevision === draftRevision && !sameDraft)
    ) {
      return "conflict";
    }
    rememberDraftAttempt(storage, target.key, storeSessionKey, draftRevision);
    store.sessions[storeSessionKey] = {
      ...(captured.awaitingDefaults ? { awaitingDefaults: true as const } : {}),
      ...(draft ? { draft } : {}),
      ...(goalMode ? { goalMode } : {}),
      draftRevision,
      ...(session?.queue?.length ? { queue: session.queue } : {}),
      updatedAt: Date.now(),
    };
    writeStore(storage, target, store);
    const persisted = readStore(storage, target).sessions[storeSessionKey];
    if (
      persisted?.draftRevision === draftRevision &&
      (persisted.draft ?? "") === draft &&
      JSON.stringify(persisted.goalMode ?? null) === JSON.stringify(goalMode ?? null)
    ) {
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
  captured: ReturnType<typeof captureChatOutboxAdmission>,
  item: ChatQueueItem,
  replaces?: StoredChatQueueReplacement,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !captured.scope.sessionKey.trim()) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = captured.scope;
    const serialized = serializeQueueItemForScope(item, scope);
    if (!serialized) {
      return false;
    }
    const migrated = resolvePendingComposerSessions(store, state);
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
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
    if (captured.awaitingDefaults) {
      store.sessions[storeSessionKey]!.awaitingDefaults = true;
    }
    writeStore(storage, target, store);
    const persisted = readStore(storage, target).sessions[storeSessionKey]?.queue?.find(
      (entry) => entry.id === serialized.id,
    );
    // Verify the captured write before subscribers can change defaults or drain it.
    const admitted = Boolean(persisted && queueItemsEqual(persisted, serialized, scope));
    notifyStoredChatOutboxChanges();
    return admitted;
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
    const scope = {
      sessionKey,
      agentId: agentId ?? updates[0]!.expected.agentId ?? updates[0]!.next.agentId,
    };
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
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
    const persistedQueue = readStore(storage, target).sessions[storeSessionKey]?.queue ?? [];
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
    const scope = { sessionKey, agentId: agentId ?? expected?.agentId };
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
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
    const persisted = readStore(storage, target).sessions[storeSessionKey]?.queue?.some(
      (item) => item.id === id,
    );
    return !persisted;
  } catch {
    return false;
  }
}

export function restoreChatComposerState(
  state: ChatComposerPersistenceState,
  options: RestoreOptions = {},
): boolean {
  state.chatMessage = normalizeChatComposerDraft(state.chatMessage);
  const sessionKey = options.sessionKey ?? state.sessionKey;
  const snapshot = loadChatComposerSnapshot(state, sessionKey);
  if (!snapshot) {
    return false;
  }
  if (!options.preserveCurrent || (!state.chatMessage && !state.chatGoalDraftMode)) {
    state.chatMessage = normalizeChatComposerDraft(snapshot.draft);
    state.chatGoalDraftMode = snapshot.goalMode ?? null;
  }
  if ((!options.preserveCurrent && snapshot.queue.length > 0) || state.chatQueue.length === 0) {
    state.chatQueue = snapshot.queue;
  }
  return true;
}

type ChatComposerDraftSnapshot = {
  scope: StoredChatOutboxScope;
  awaitingDefaults: boolean;
  sessionKey: string;
  chatMessage: string;
  goalMode?: ChatGoalDraftMode;
  expectedDraftRevision: number;
  draftRevision: number;
  attachments: ChatAttachment[];
  durable?: DurableChatComposerSnapshot;
};

export class ChatComposerPersistence {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ready = false;
  private pending: ChatComposerDraftSnapshot | null = null;
  private publishing = false;
  private lastPersisted: ChatComposerDraftSnapshot | null = null;
  private committedDraftRevision = 0;
  private latestDraftRevision = 0;
  private durableRestoreProtected = false;
  // A transient disconnect invalidates scope readiness, not the owner authenticated
  // by this client. Client or Gateway replacement still fences the cached owner.
  private durableOwner: {
    client: ChatComposerPersistenceState["client"];
    gatewayOwner: string;
    recoveryScope: string;
  } | null = null;
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
    const { revisions, snapshot: stored } = loadCapturedChatComposerState(
      state,
      resolveUiConversationIdentity(state, state.sessionKey),
    );
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    this.durableRestoreProtected =
      (state.chatAttachments?.length ?? 0) > 0 ||
      (stored?.draft ?? "") !== state.chatMessage ||
      JSON.stringify(stored?.goalMode ?? null) !== JSON.stringify(state.chatGoalDraftMode ?? null);
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
    if (this.isUnchanged(state)) {
      if (!this.pending) {
        this.clearTimer();
        return;
      }
      if (this.matchesCurrentContent(this.pending, state)) {
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
    if (!this.ready || !state || this.publishing) {
      return;
    }
    let snapshot = this.pending;
    if (!snapshot) {
      if (this.isUnchanged(state)) {
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
    this.persistSnapshot(state, snapshot);
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
    return (
      (this.pending ?? (this.isUnchanged(state) ? this.lastPersisted : null))?.scope ??
      resolveUiConversationIdentity(state, state.sessionKey)
    );
  }

  persistForRouteSwitchResult(): ChatComposerPersistResult {
    const state = this.getState();
    if (!state) {
      return { status: "persisted" };
    }
    let snapshot = this.pending;
    let enforceExpectedRevision = false;
    if (!snapshot && this.ready && this.isUnchanged(state)) {
      const baseline = this.lastPersisted!;
      if (!baseline.chatMessage && !baseline.goalMode && baseline.attachments.length === 0) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      const { revisions, snapshot: stored } = loadCapturedChatComposerState(state, baseline.scope);
      const storedRevision = revisions.committed;
      if (
        baseline.attachments.length === 0 &&
        storedRevision === baseline.draftRevision &&
        stored?.draft === baseline.chatMessage &&
        JSON.stringify(stored?.goalMode ?? null) === JSON.stringify(baseline.goalMode ?? null)
      ) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      if (storedRevision !== baseline.draftRevision || Boolean(stored?.draft || stored?.goalMode)) {
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
    } else if (
      !snapshot &&
      !this.ready &&
      !normalizeChatComposerDraft(state.chatMessage) &&
      !state.chatGoalDraftMode
    ) {
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
    return this.persistSnapshot(state, snapshot, enforceExpectedRevision);
  }

  private persistSnapshot(
    state: DurableChatComposerPersistenceState,
    snapshot: ChatComposerDraftSnapshot,
    enforceExpectedRevision = false,
  ): ChatComposerPersistResult {
    // Presence notifications synchronously reenter the controller. Publish this
    // exact snapshot first; subscribers must not mint a second write for it.
    this.pending = snapshot;
    this.publishing = true;
    let status: ChatComposerPersistStatus;
    try {
      status = persistCapturedChatComposerStateResult(state, snapshot, {
        draft: snapshot.chatMessage,
        goalMode: snapshot.goalMode ?? null,
        draftRevision: snapshot.draftRevision,
        ...(enforceExpectedRevision
          ? { expectedDraftRevision: snapshot.expectedDraftRevision }
          : {}),
      });
    } finally {
      this.publishing = false;
    }
    if (snapshot.durable) {
      this.durablePersistence.persist(snapshot.durable);
    }
    if (status === "persisted" && this.pending === snapshot) {
      this.pending = null;
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

  private isUnchanged(state: ChatComposerPersistenceState): boolean {
    const last = this.lastPersisted;
    return Boolean(
      last && last.sessionKey === state.sessionKey && this.matchesCurrentContent(last, state),
    );
  }

  private matchesCurrentContent(
    snapshot: ChatComposerDraftSnapshot,
    state: ChatComposerPersistenceState,
  ): boolean {
    return (
      chatAttachmentDraftSignature(
        snapshot.chatMessage,
        snapshot.attachments,
        snapshot.goalMode,
      ) ===
      chatAttachmentDraftSignature(
        normalizeChatComposerDraft(state.chatMessage),
        state.chatAttachments ?? [],
        state.chatGoalDraftMode,
      )
    );
  }

  private snapshot(
    state: DurableChatComposerPersistenceState,
    draftRevision: number = this.latestDraftRevision,
    expectedDraftRevision: number = this.committedDraftRevision,
  ): ChatComposerDraftSnapshot {
    const scope = resolveUiConversationIdentity(state, state.sessionKey);
    const durableScope = this.resolveDurableScope(state, scope);
    const goalMode = state.chatGoalDraftMode ? { ...state.chatGoalDraftMode } : undefined;
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
          text: normalizeChatComposerDraft(state.chatMessage),
          ...(goalMode ? { goalMode } : {}),
          storedAttachments: captureDurableChatAttachments(attachments),
          writeId: `${draftRevision}:${Math.random().toString(36).slice(2)}`,
        }
      : undefined;
    return {
      scope,
      awaitingDefaults: !hasUiSessionDefaults(state),
      sessionKey: state.sessionKey,
      chatMessage: normalizeChatComposerDraft(state.chatMessage),
      ...(goalMode ? { goalMode } : {}),
      expectedDraftRevision,
      draftRevision,
      attachments,
      ...(durable ? { durable } : {}),
    };
  }

  private resolveDurableScope(
    state: DurableChatComposerPersistenceState,
    scope: StoredChatOutboxScope = resolveUiConversationIdentity(state, state.sessionKey),
  ) {
    if (state.selectedChatSessionIncognito) {
      return null;
    }
    return (
      this.resolveConnectedDurableScope(state, scope) ??
      (this.durableOwner &&
      !state.connected &&
      this.durableOwner.client === state.client &&
      this.durableOwner.gatewayOwner ===
        storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner
        ? { ...this.durableOwner, scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}` }
        : null)
    );
  }

  private resolveConnectedDurableScope(
    state: DurableChatComposerPersistenceState,
    scope: StoredChatOutboxScope = resolveUiConversationIdentity(state, state.sessionKey),
  ) {
    const recoveryScope = state.client?.recoveryScope?.trim();
    if (!state.connected || !state.client?.recoveryScopeReady || !recoveryScope) {
      return null;
    }
    return {
      gatewayOwner: storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner,
      recoveryScope,
      scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}`,
    };
  }

  private synchronizeDurablePersistence() {
    const state = this.getState();
    if (!this.ready || !state || this.publishing) {
      return;
    }
    const connectedScope = this.resolveConnectedDurableScope(state);
    if (state.selectedChatSessionIncognito) {
      if (connectedScope) {
        const scopeKey = durableComposerScopeIdentity(connectedScope);
        if (this.durableRetiredScopeKey !== scopeKey) {
          this.durableRetiredScopeKey = scopeKey;
          this.durableOwner = null;
          this.forceDurableOwnerRestore = false;
          this.durableRestoreProtected = false;
          this.durablePersistence.retire(connectedScope, this.latestDraftRevision);
        }
      }
      return;
    }
    this.durableRetiredScopeKey = "";
    const scope = this.resolveDurableScope(state);
    if (!scope) {
      return;
    }
    const previousOwner = this.durableOwner;
    // Draft writes notify panes synchronously. Publish the new owner before
    // clearing the old draft so reentrant persistence cannot repeat this transition.
    this.durableOwner = {
      client: state.client,
      gatewayOwner: scope.gatewayOwner,
      recoveryScope: scope.recoveryScope,
    };
    if (
      previousOwner &&
      (previousOwner.gatewayOwner !== scope.gatewayOwner ||
        previousOwner.recoveryScope !== scope.recoveryScope)
    ) {
      releaseChatAttachmentPayloads(state.chatAttachments);
      state.chatMessage = "";
      state.chatGoalDraftMode = null;
      state.chatAttachments = [];
      this.pending = null;
      const revisions = this.readDraftRevisions(state);
      this.committedDraftRevision = revisions.committed;
      this.latestDraftRevision = nextDraftRevision(revisions.latestAttempt);
      persistChatComposerStateResult(state, state.sessionKey, {
        draft: "",
        goalMode: null,
        draftRevision: this.latestDraftRevision,
      });
      this.committedDraftRevision = this.latestDraftRevision;
      this.lastPersisted = this.snapshot(state, this.latestDraftRevision, this.latestDraftRevision);
      this.durableRestoreProtected = false;
      this.forceDurableOwnerRestore = true;
      this.durablePersistence.resetRestoreScope();
    }
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
        latestRevision: restoreRevision,
        signature: chatAttachmentDraftSignature(
          state.chatMessage,
          state.chatAttachments ?? [],
          state.chatGoalDraftMode,
        ),
      },
      () => ({
        scope: this.resolveDurableScope(state),
        signature: chatAttachmentDraftSignature(
          state.chatMessage,
          state.chatAttachments ?? [],
          state.chatGoalDraftMode,
        ),
        revision: this.forceDurableOwnerRestore ? 0 : this.latestDraftRevision,
      }),
      (draft) => {
        const forceOwnerRestore = this.forceDurableOwnerRestore;
        this.forceDurableOwnerRestore = false;
        const displaced = state.chatAttachments ?? [];
        state.chatMessage = normalizeChatComposerDraft(draft.text);
        state.chatGoalDraftMode = draft.goalMode ?? null;
        state.chatAttachments = draft.attachments;
        releaseChatAttachmentPayloads(displaced);
        const adoptedRevision = forceOwnerRestore
          ? nextDraftRevision(Math.max(this.latestDraftRevision, draft.revision))
          : draft.revision;
        // Storage presence notifications synchronously invalidate every pane. Adopt
        // the complete restored draft before they can schedule another write.
        this.committedDraftRevision = adoptedRevision;
        this.latestDraftRevision = adoptedRevision;
        this.lastPersisted = this.snapshot(state, adoptedRevision, adoptedRevision);
        persistChatComposerStateResult(state, state.sessionKey, {
          agentId: resolveUiConversationIdentity(state, state.sessionKey).agentId,
          draft: state.chatMessage,
          goalMode: state.chatGoalDraftMode,
          draftRevision: adoptedRevision,
        });
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
        if (
          baseline.durable &&
          (state.chatMessage || state.chatGoalDraftMode || (state.chatAttachments?.length ?? 0) > 0)
        ) {
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
    scope = resolveUiConversationIdentity(state, state.sessionKey),
  ): ChatComposerDraftRevisionState {
    return loadCapturedChatComposerState(state, scope).revisions;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
