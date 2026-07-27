import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  nextDraftRevision,
  rememberDraftAttempt,
  rememberDraftRevision,
  rememberedDraftAttempt,
  rememberedDraftRevision,
} from "../../lib/chat/outbox-store-draft-state.ts";
import {
  notifyStoredChatOutboxChanges,
  resolveComposerStorageScope,
  resolveStoredChatOutboxScope,
  storageTargetForGateway,
  UNRESOLVED_GLOBAL_AGENT_SCOPE,
  type ChatComposerScope,
  type ComposerStorageScope,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
import { normalizeSenderIdentity } from "../../lib/chat/sender-label.ts";
// Control UI chat module implements composer persistence behavior.
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  applyStoredChatOutboxScope,
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  MAX_STORED_QUEUE_ITEMS,
  normalizeOptionalString,
  normalizeSkillWorkshopRevision,
  normalizeStoredSession,
  resolveStoredComposerSession,
  type StoredComposerSession,
  type StoredComposerState,
} from "./composer-outbox-store.ts";
import {
  readComposerStore as readStore,
  writeComposerStore as writeStore,
} from "./composer-storage.ts";
import { isInflightSteer, isSteeredQueueItem } from "./steered-chip.ts";

const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;
export const CHAT_COMPOSER_DRAFT_STORAGE_ERROR =
  "Could not store the previous draft in browser storage. It remains available in this tab.";

export {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  listStoredChatOutboxes,
} from "./composer-outbox-store.ts";
export {
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
export type { ChatComposerScope, StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
export type { StoredChatOutbox } from "./composer-outbox-store.ts";

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

type RestoreOptions = {
  preserveCurrent?: boolean;
  sessionKey?: string;
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
      : item.sendState === "executing-command" || isInflightSteer(item)
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
  const sender = normalizeSenderIdentity(item.sender);
  return {
    id,
    text,
    createdAt:
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
    ...(item.kind === "queued" || isSteeredQueueItem(item) ? { kind: item.kind } : {}),
    ...(attachments.length ? { attachments: attachments as ChatAttachment[] } : {}),
    ...(typeof item.refreshSessions === "boolean" ? { refreshSessions: item.refreshSessions } : {}),
    ...(item.replyToId ? { replyToId: item.replyToId } : {}),
    ...(item.localCommandArgs ? { localCommandArgs: item.localCommandArgs } : {}),
    ...(item.localCommandName ? { localCommandName: item.localCommandName } : {}),
    ...(item.sessionKey ? { sessionKey: item.sessionKey } : {}),
    ...(item.agentId ? { agentId: item.agentId } : {}),
    ...(sender ? { sender } : {}),
    ...(skillWorkshopRevision ? { skillWorkshopRevision } : {}),
    ...(sendState ? { sendState } : {}),
    ...(sendError ? { sendError } : {}),
    ...(item.sendRunId ? { sendRunId: item.sendRunId } : {}),
    ...(typeof item.sendAttempts === "number" && Number.isFinite(item.sendAttempts)
      ? { sendAttempts: item.sendAttempts }
      : {}),
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
    notifyStoredChatOutboxChanges();
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
