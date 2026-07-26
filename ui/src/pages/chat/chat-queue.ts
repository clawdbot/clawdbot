// Control UI page module owns Chat queue storage and queue item cleanup.
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { SenderIdentity } from "../../lib/chat/sender-label.ts";
import {
  scopedAgentIdForSession,
  visibleSessionMatches,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { cloneChatAttachmentsMetadata } from "./attachment-payload-store.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  removeStoredChatComposerQueueItem,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  updateStoredChatComposerQueueItem,
  type ChatComposerScope,
  type StoredChatOutbox,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";

type ChatQueueStoreHost = {
  chatQueue: ChatQueueItem[];
  chatQueueByScope?: Record<string, ChatQueueItem[]>;
  chatAttachments?: ChatAttachment[];
  chatRunId?: string | null;
  chatSending?: boolean;
  chatSendingScopeKey?: string | null;
  requestUpdate?: () => void;
};

type ChatQueueSessionHost = ChatQueueStoreHost &
  ChatComposerScope & {
    sessionKey: string;
  };

export type ChatQueueScopedSessionHost = ChatQueueSessionHost & SessionScopeHost;

const chatOutboxProjectionHosts = new Set<ChatQueueScopedSessionHost>();
// Durable rows use crash-safe states. Overlay live work process-wide so panes
// attached mid-operation cannot retry or remove it before the owner settles.
const transientQueueProjections = new Map<string, ChatQueueItem>();
// A storage-rejected row may exist only in one pane. Track that provenance so
// projection keeps its active/manual-retry copy without resurrecting removed rows.
const localRecoveryItemIds = new WeakMap<ChatQueueScopedSessionHost, Set<string>>();
// Volatile provenance is stricter than local recovery: only the connected
// quota fallback may bypass durable admission on an explicit retry.
const volatileQueueItemIds = new WeakMap<ChatQueueScopedSessionHost, Set<string>>();

export function markLocalRecoveryItem(host: ChatQueueScopedSessionHost, id: string): void {
  const ids = localRecoveryItemIds.get(host) ?? new Set<string>();
  ids.add(id);
  localRecoveryItemIds.set(host, ids);
}

function clearLocalRecoveryItem(host: ChatQueueScopedSessionHost, id: string): void {
  const ids = localRecoveryItemIds.get(host);
  ids?.delete(id);
  if (ids?.size === 0) {
    localRecoveryItemIds.delete(host);
  }
}

export function isVolatileQueuedMessage(host: ChatQueueScopedSessionHost, id: string): boolean {
  return volatileQueueItemIds.get(host)?.has(id) === true;
}

export function markVolatileQueuedMessage(host: ChatQueueScopedSessionHost, id: string): void {
  const ids = volatileQueueItemIds.get(host) ?? new Set<string>();
  ids.add(id);
  volatileQueueItemIds.set(host, ids);
}

function clearVolatileQueuedMessage(host: ChatQueueScopedSessionHost, id: string): void {
  const ids = volatileQueueItemIds.get(host);
  ids?.delete(id);
  if (ids?.size === 0) {
    volatileQueueItemIds.delete(host);
  }
}

function queueProjectionGatewayKey(host: ChatComposerScope): string {
  return host.settings?.gatewayUrl?.trim() || "default";
}

function transientQueueProjectionKey(
  host: ChatComposerScope,
  scope: StoredChatOutboxScope,
  id: string,
): string {
  return `${queueProjectionGatewayKey(host)}\u0000${storedChatOutboxScopeKey(scope)}\u0000${id}`;
}

function transientQueueProjection(
  host: ChatComposerScope,
  outbox: StoredChatOutbox,
  id: string,
): ChatQueueItem | undefined {
  return transientQueueProjections.get(transientQueueProjectionKey(host, outbox, id));
}

function isProcessLiveQueueProjection(item: ChatQueueItem): boolean {
  return item.sendState === "sending" || item.sendState === "executing-command";
}

function updateProcessLiveQueueProjection(
  host: ChatComposerScope,
  scope: StoredChatOutboxScope,
  item: ChatQueueItem,
): void {
  const key = transientQueueProjectionKey(host, scope, item.id);
  if (isProcessLiveQueueProjection(item)) {
    transientQueueProjections.set(key, item);
  } else {
    transientQueueProjections.delete(key);
  }
}

function storedOutboxContainingItem(
  host: ChatComposerScope,
  id: string,
): StoredChatOutbox | undefined {
  return listStoredChatOutboxes(host).find((outbox) => outbox.queue.some((item) => item.id === id));
}

function sameStoredOutboxScope(left: StoredChatOutboxScope, right: StoredChatOutboxScope): boolean {
  return left.sessionKey === right.sessionKey && left.agentId === right.agentId;
}

function outboxAfterMutation(host: ChatComposerScope, before: StoredChatOutbox): StoredChatOutbox {
  return (
    listStoredChatOutboxes(host).find((outbox) => sameStoredOutboxScope(outbox, before)) ?? {
      sessionKey: before.sessionKey,
      ...(before.agentId ? { agentId: before.agentId } : {}),
      queue: [],
    }
  );
}

export function syncChatQueueFromStoredOutbox(
  host: ChatQueueScopedSessionHost,
  outbox: StoredChatOutbox,
  options: { requestUpdate?: boolean } = {},
) {
  const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
  const scopeKey = storedChatOutboxScopeKey(outbox);
  const current = visible ? host.chatQueue : (host.chatQueueByScope?.[scopeKey] ?? []);
  const ephemeral = current.filter((item) => item.pendingRunId);
  const ephemeralById = new Map(ephemeral.map((item) => [item.id, item]));
  const storedIds = new Set(outbox.queue.map((item) => item.id));
  // Storage failures can leave an active or manual-retry row in memory only.
  // Projection must not erase that last copy while another send publishes.
  const localRecovery = current.filter(
    (item) =>
      !item.pendingRunId && !storedIds.has(item.id) && localRecoveryItemIds.get(host)?.has(item.id),
  );
  const projected = outbox.queue.map((item) => {
    const ephemeralItem = ephemeralById.get(item.id);
    if (ephemeralItem) {
      return ephemeralItem;
    }
    const transientItem = transientQueueProjection(host, outbox, item.id);
    if (transientItem) {
      return transientItem;
    }
    const local = current.find(
      (candidate) => candidate.id === item.id && candidate.sendRunId === item.sendRunId,
    );
    const keepLiveSendingState =
      item.sendState === "waiting-reconnect" &&
      local?.sendState === "sending" &&
      local.sendAttempts === item.sendAttempts &&
      ((host.chatSending === true && host.chatSendingScopeKey === scopeKey) ||
        host.chatRunId === item.sendRunId);
    const keepLiveCommandState =
      item.sendState === "unconfirmed" &&
      local?.sendState === "executing-command" &&
      local.localCommandName === item.localCommandName &&
      local.localCommandArgs === item.localCommandArgs;
    return {
      ...item,
      ...(keepLiveSendingState
        ? { sendState: "sending" as const }
        : keepLiveCommandState
          ? { sendState: "executing-command" as const }
          : {}),
      ...(typeof local?.sendSubmittedAtMs === "number"
        ? { sendSubmittedAtMs: local.sendSubmittedAtMs }
        : {}),
      ...(typeof local?.sendRequestStartedAtMs === "number"
        ? { sendRequestStartedAtMs: local.sendRequestStartedAtMs }
        : {}),
    };
  });
  const detachedEphemeral = ephemeral.filter((item) => !storedIds.has(item.id));
  const queue = [...projected, ...localRecovery, ...detachedEphemeral].toSorted(
    (left, right) => left.createdAt - right.createdAt,
  );
  if (visible) {
    host.chatQueue = queue;
  } else {
    const queueByScope = { ...host.chatQueueByScope };
    if (queue.length) {
      queueByScope[scopeKey] = queue;
    } else {
      delete queueByScope[scopeKey];
    }
    host.chatQueueByScope = queueByScope;
  }
  if (options.requestUpdate !== false) {
    host.requestUpdate?.();
  }
}

export function syncVisibleChatQueueProjection(
  host: ChatQueueScopedSessionHost,
  options: { requestUpdate?: boolean } = {},
): void {
  const outbox = listStoredChatOutboxes(host).find((candidate) =>
    visibleSessionMatches(host, candidate.sessionKey, candidate.agentId),
  );
  if (outbox) {
    syncChatQueueFromStoredOutbox(host, outbox, options);
  }
}

function publishStoredOutbox(source: ChatQueueScopedSessionHost, outbox: StoredChatOutbox) {
  for (const host of chatOutboxProjectionHosts) {
    const sameGateway =
      (host.settings?.gatewayUrl?.trim() || "default") ===
      (source.settings?.gatewayUrl?.trim() || "default");
    const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
    const hasCachedScope = Object.hasOwn(
      host.chatQueueByScope ?? {},
      storedChatOutboxScopeKey(outbox),
    );
    if (host === source || !sameGateway || (!visible && !hasCachedScope)) {
      continue;
    }
    syncChatQueueFromStoredOutbox(host, outbox);
  }
}

function storedOutboxForProjection(
  host: ChatQueueScopedSessionHost,
  scope: StoredChatOutboxScope,
): StoredChatOutbox {
  return (
    listStoredChatOutboxes(host).find((outbox) => sameStoredOutboxScope(outbox, scope)) ?? {
      ...scope,
      queue: [],
    }
  );
}

export function setTransientQueuedMessageProjection(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  item: ChatQueueItem,
  agentId?: string,
): boolean {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId);
  const outbox = storedOutboxForProjection(host, scope);
  if (!outbox.queue.some((entry) => entry.id === item.id)) {
    return false;
  }
  transientQueueProjections.set(transientQueueProjectionKey(host, scope, item.id), item);
  syncChatQueueFromStoredOutbox(host, outbox);
  publishStoredOutbox(host, outbox);
  return true;
}

export function clearTransientQueuedMessageProjection(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  id: string,
  agentId?: string,
) {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId);
  transientQueueProjections.delete(transientQueueProjectionKey(host, scope, id));
  const outbox = storedOutboxForProjection(host, scope);
  syncChatQueueFromStoredOutbox(host, outbox);
  publishStoredOutbox(host, outbox);
}

export function subscribeChatOutboxProjection(host: ChatQueueScopedSessionHost): () => void {
  chatOutboxProjectionHosts.add(host);
  for (const outbox of listStoredChatOutboxes(host)) {
    const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
    const hasCachedScope = Object.hasOwn(
      host.chatQueueByScope ?? {},
      storedChatOutboxScopeKey(outbox),
    );
    if (visible || hasCachedScope) {
      syncChatQueueFromStoredOutbox(host, outbox);
    }
  }
  return () => chatOutboxProjectionHosts.delete(host);
}

export function enqueueChatMessage(
  host: ChatQueueScopedSessionHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
  sender?: SenderIdentity,
): ChatQueueItem | null {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return null;
  }
  const item: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
    refreshSessions,
    localCommandArgs: localCommand?.args,
    localCommandName: localCommand?.name,
    sessionKey: host.sessionKey,
    agentId: scopedAgentIdForSession(host, host.sessionKey),
    ...(sender ? { sender } : {}),
  };
  host.chatQueue = [...host.chatQueue, item];
  return item;
}

export function enqueuePendingRunMessage(
  host: ChatQueueSessionHost,
  text: string,
  pendingRunId: string,
  attachments?: ChatAttachment[],
  sender?: SenderIdentity,
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  // Local commands join an existing run without a wire chat.send, so this is
  // intentionally a non-SteeredChip pending row with no fake sendRunId.
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      kind: "steered",
      attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
      pendingRunId,
      ...(sender ? { sender } : {}),
    },
  ];
}

export function readChatQueueForScope(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  agentId?: string,
): ChatQueueItem[] {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId);
  return visibleSessionMatches(host, scope.sessionKey, scope.agentId)
    ? host.chatQueue
    : (host.chatQueueByScope?.[storedChatOutboxScopeKey(scope)] ?? []);
}

export function replacePendingQueuedMessageProjection(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  id: string,
  pendingRunId: string,
  replacement: ChatQueueItem,
  agentId?: string,
): boolean {
  const queue = readChatQueueForScope(host, sessionKey, agentId);
  if (!queue.some((item) => item.id === id && item.pendingRunId === pendingRunId)) {
    return false;
  }
  writeChatQueueForScope(
    host,
    sessionKey,
    queue.map((item) =>
      item.id === id && item.pendingRunId === pendingRunId ? replacement : item,
    ),
    agentId,
  );
  return true;
}

export function writeChatQueueForScope(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  queue: ChatQueueItem[],
  agentId?: string,
) {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId);
  if (visibleSessionMatches(host, scope.sessionKey, scope.agentId)) {
    host.chatQueue = queue;
    return;
  }
  const scopeKey = storedChatOutboxScopeKey(scope);
  const queueByScope = { ...host.chatQueueByScope };
  if (queue.length > 0) {
    queueByScope[scopeKey] = queue;
  } else {
    delete queueByScope[scopeKey];
  }
  host.chatQueueByScope = queueByScope;
  host.requestUpdate?.();
}

function locateChatQueueItem(
  host: ChatQueueSessionHost,
  id: string,
): { active: boolean; queue: ChatQueueItem[]; scopeKey?: string } | null {
  if (host.chatQueue.some((item) => item.id === id)) {
    return { active: true, queue: host.chatQueue };
  }
  for (const [scopeKey, queue] of Object.entries(host.chatQueueByScope ?? {})) {
    if (queue.some((item) => item.id === id)) {
      return { active: false, queue, scopeKey };
    }
  }
  return null;
}

function writeLocatedChatQueue(
  host: ChatQueueSessionHost,
  location: { active: boolean; scopeKey?: string },
  queue: ChatQueueItem[],
) {
  if (location.active) {
    host.chatQueue = queue;
    return;
  }
  if (!location.scopeKey) {
    return;
  }
  const queueByScope = { ...host.chatQueueByScope };
  if (queue.length) {
    queueByScope[location.scopeKey] = queue;
  } else {
    delete queueByScope[location.scopeKey];
  }
  host.chatQueueByScope = queueByScope;
  host.requestUpdate?.();
}

export function readQueuedMessageById(
  host: ChatQueueSessionHost,
  id: string,
): ChatQueueItem | null {
  const location = locateChatQueueItem(host, id);
  return (
    location?.queue.find((item) => item.id === id) ??
    storedOutboxContainingItem(host, id)?.queue.find((item) => item.id === id) ??
    null
  );
}

export function updateQueuedMessage(
  host: ChatQueueScopedSessionHost,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return updateQueuedMessageForSession(host, host.sessionKey, id, update);
}

export function updateVolatileQueuedMessage(
  host: ChatQueueScopedSessionHost,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  const location = locateChatQueueItem(host, id);
  const current = location?.queue.find((item) => item.id === id);
  if (!location || !current) {
    return null;
  }
  markLocalRecoveryItem(host, id);
  markVolatileQueuedMessage(host, id);
  const nextItem = update(current);
  writeLocatedChatQueue(
    host,
    location,
    location.queue.map((item) => (item.id === id ? nextItem : item)),
  );
  return nextItem;
}

export function updateQueuedMessageForSession(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
  agentId?: string,
): ChatQueueItem | null {
  const location = locateChatQueueItem(host, id);
  const stored = storedOutboxContainingItem(host, id);
  const scope: StoredChatOutboxScope =
    stored ?? resolveStoredChatOutboxScope(host, sessionKey, agentId);
  const cachedQueue =
    location?.queue ?? readChatQueueForScope(host, scope.sessionKey, scope.agentId);
  const storedItem = stored?.queue.find((item) => item.id === id);
  const current = cachedQueue.find((item) => item.id === id) ?? storedItem;
  if (!current) {
    return null;
  }
  const queue = cachedQueue.length || !stored ? cachedQueue : stored.queue;
  const nextItem = update(current);
  if (
    stored &&
    !updateStoredChatComposerQueueItem(
      host,
      stored.sessionKey,
      current,
      nextItem,
      stored.agentId ?? current.agentId ?? nextItem.agentId,
    )
  ) {
    if (!isProcessLiveQueueProjection(nextItem)) {
      updateProcessLiveQueueProjection(host, scope, nextItem);
    }
    const persisted = outboxAfterMutation(host, stored);
    syncChatQueueFromStoredOutbox(host, persisted);
    publishStoredOutbox(host, persisted);
    return null;
  }
  updateProcessLiveQueueProjection(host, scope, nextItem);
  const nextQueue = queue.map((item) => (item.id === id ? nextItem : item));
  if (location) {
    writeLocatedChatQueue(host, location, nextQueue);
  } else {
    writeChatQueueForScope(host, scope.sessionKey, nextQueue, scope.agentId);
  }
  if (stored) {
    const persisted = outboxAfterMutation(host, stored);
    publishStoredOutbox(host, {
      ...persisted,
      queue: persisted.queue.map((item) => (item.id === id ? nextItem : item)),
    });
  }
  return nextItem;
}

export function admitQueuedMessageForSession(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  item: ChatQueueItem,
): boolean {
  if (!admitStoredChatComposerQueueItem(host, sessionKey, item, item.agentId)) {
    if (item.sendState === "failed") {
      markLocalRecoveryItem(host, item.id);
    }
    return false;
  }
  clearLocalRecoveryItem(host, item.id);
  clearVolatileQueuedMessage(host, item.id);
  const stored = storedOutboxContainingItem(host, item.id);
  if (!stored) {
    return false;
  }
  publishStoredOutbox(host, stored);
  return true;
}

export function removeQueuedMessageWithoutReleasing(
  host: ChatQueueScopedSessionHost,
  id: string,
  sessionKey = host.sessionKey,
  agentId?: string,
): ChatQueueItem | null {
  const location = locateChatQueueItem(host, id);
  const stored = storedOutboxContainingItem(host, id);
  const scope: StoredChatOutboxScope =
    stored ?? resolveStoredChatOutboxScope(host, sessionKey, agentId);
  const cachedQueue =
    location?.queue ?? readChatQueueForScope(host, scope.sessionKey, scope.agentId);
  const storedItem = stored?.queue.find((entry) => entry.id === id) ?? null;
  const item = cachedQueue.find((entry) => entry.id === id) ?? storedItem;
  const queue = cachedQueue.length || !stored ? cachedQueue : stored.queue;
  if (
    item &&
    stored &&
    !removeStoredChatComposerQueueItem(
      host,
      stored.sessionKey,
      id,
      item,
      stored.agentId ?? item.agentId,
    )
  ) {
    const persisted = outboxAfterMutation(host, stored);
    syncChatQueueFromStoredOutbox(host, persisted);
    publishStoredOutbox(host, persisted);
    return null;
  }
  if (item) {
    transientQueueProjections.delete(transientQueueProjectionKey(host, scope, item.id));
  }
  const nextQueue = queue.filter((entry) => entry.id !== id);
  if (location) {
    writeLocatedChatQueue(host, location, nextQueue);
  } else {
    writeChatQueueForScope(host, scope.sessionKey, nextQueue, scope.agentId);
  }
  if (stored) {
    publishStoredOutbox(host, outboxAfterMutation(host, stored));
  }
  if (item) {
    clearLocalRecoveryItem(host, id);
    clearVolatileQueuedMessage(host, id);
  }
  return item;
}

export function removeVisibleOrScopedQueuedMessageWithoutReleasing(
  host: ChatQueueScopedSessionHost,
  id: string,
  sessionKey: string | undefined,
): ChatQueueItem | null {
  return (
    removeQueuedMessageWithoutReleasing(host, id) ??
    (sessionKey ? removeQueuedMessageWithoutReleasing(host, id, sessionKey) : null)
  );
}

export function excludeComposerAttachments(
  host: { chatAttachments?: ChatAttachment[] },
  attachments: readonly ChatAttachment[] | undefined,
): ChatAttachment[] | undefined {
  if (!attachments?.length) {
    return attachments ? [] : undefined;
  }
  const retainedIds = new Set((host.chatAttachments ?? []).map((attachment) => attachment.id));
  return attachments.filter((attachment) => !retainedIds.has(attachment.id));
}

export function removeQueuedMessage(host: ChatQueueScopedSessionHost, id: string) {
  const removed = removeQueuedMessageWithoutReleasing(host, id);
  if (removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
}

export function removeDeliveredQueuedChatSendForRun(
  host: ChatQueueScopedSessionHost,
  runId: string | undefined,
): ChatQueueItem | null {
  const match = readDeliveredQueuedChatSendForRun(host, runId);
  if (!match) {
    return null;
  }
  const removed = removeQueuedMessageWithoutReleasing(
    host,
    match.item.id,
    match.outbox.sessionKey,
    match.outbox.agentId,
  );
  if (!removed) {
    return null;
  }
  releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  return removed;
}

export function readDeliveredQueuedChatSendForRun(
  host: ChatQueueScopedSessionHost,
  runId: string | undefined,
): { item: ChatQueueItem; outbox: StoredChatOutbox } | null {
  if (!runId) {
    return null;
  }
  const match = listStoredChatOutboxes(host)
    .flatMap((outbox) => outbox.queue.map((item) => ({ item, outbox })))
    .find(({ item }) => item.sendRunId === runId);
  return match ?? null;
}

export function clearPendingQueueItemsForRun(
  host: Pick<ChatQueueSessionHost, "chatAttachments" | "chatQueue">,
  runId: string | undefined,
) {
  if (!runId) {
    return;
  }
  const removed = host.chatQueue.filter((item) => item.pendingRunId === runId);
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
}

export function markQueuedChatSendsWaitingForReconnect(host: ChatQueueScopedSessionHost) {
  const items = [...host.chatQueue, ...Object.values(host.chatQueueByScope ?? {}).flat()];
  for (const item of items) {
    if (!item.sendRunId || (item.sendState !== "sending" && item.sendState !== "waiting-idle")) {
      continue;
    }
    if (isVolatileQueuedMessage(host, item.id)) {
      updateVolatileQueuedMessage(host, item.id, (current) => ({
        ...current,
        sendState: "unconfirmed",
      }));
      continue;
    }
    updateQueuedMessageForSession(
      host,
      item.sessionKey ?? host.sessionKey,
      item.id,
      (current) => ({
        ...current,
        sendState: "waiting-reconnect",
      }),
      item.agentId,
    );
  }
}
