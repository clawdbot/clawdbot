// Control UI page module owns Chat queue storage and queue item cleanup.
import { compareChatQueueOrder, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import type { SenderIdentity } from "../../lib/chat/sender-label.ts";
import { scopedAgentIdForSession, type SessionScopeHost } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  releaseChatAttachmentPayloads,
  cloneChatAttachmentsMetadata,
} from "./attachment-payload-store.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  removeStoredChatComposerQueueItem,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  updateStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItems,
  type StoredChatQueueReplacement,
  type ChatComposerScope,
  type StoredChatOutbox,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";

type ChatQueueStoreHost = {
  chatQueue: ChatQueueItem[];
  chatAttachments?: ChatAttachment[];
  chatRunId?: string | null;
  chatSending?: boolean;
  chatSendingScopeKey?: string | null;
  requestUpdate?: () => void;
};
type ChatQueueSessionHost = ChatQueueStoreHost & ChatComposerScope & { sessionKey: string };
export type ChatQueueScopedSessionHost = ChatQueueSessionHost & SessionScopeHost;

export function isSteerableQueuedMessage(item: ChatQueueItem): boolean {
  return (
    isMovableChatQueueItem(item) &&
    (item.sendState === undefined || item.sendState === "waiting-idle") &&
    !item.localCommandName
  );
}

export function steerableQueuedMessage(queue: readonly ChatQueueItem[]): ChatQueueItem | undefined {
  return queue.toSorted(compareChatQueueOrder).find(isSteerableQueuedMessage);
}

function isProcessLiveQueueProjection(item: ChatQueueItem): boolean {
  return item.sendState === "sending" || item.sendState === "executing-command";
}

export function isVolatileQueuedMessage(host: ChatQueueScopedSessionHost, id: string): boolean {
  return chatOutboxOwner(host).hasVolatile(host, id);
}

/** True while the row has a stored copy that would survive a reload. */
export function isDurableQueuedMessage(host: ChatQueueScopedSessionHost, id: string): boolean {
  return chatOutboxOwner(host).durable(host, id) !== undefined;
}

/**
 * Every pane sharing an outbox also shares its drain, and any of them can own the
 * drain lane. A fact one pane records about a row — a delivery hold, say — has to
 * be read across all of them, or the pane that drains will not see it. Panes
 * registered with an owner are the same kind of chat host as the caller.
 */
export function anyChatOutboxPaneMatches<T extends ChatQueueScopedSessionHost>(
  host: T,
  matches: (pane: T) => boolean,
): boolean {
  return matches(host) || chatOutboxOwner(host).anyPane((pane) => matches(pane as T));
}

export function keepVolatileQueuedMessage(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  item: ChatQueueItem,
  agentId?: string,
  options: { retryable?: boolean } = {},
): void {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId ?? item.agentId);
  chatOutboxOwner(host).keep(host, scope, item, options.retryable);
}

export function syncVisibleChatQueueProjection(
  host: ChatQueueScopedSessionHost,
  options: { requestUpdate?: boolean } = {},
): void {
  chatOutboxOwner(host).syncHost(host, options);
}

export function subscribeChatOutboxProjection(host: ChatQueueScopedSessionHost): () => void {
  return chatOutboxOwner(host).subscribe(host);
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
  keepVolatileQueuedMessage(host, host.sessionKey, item, item.agentId);
  return item;
}

export function enqueuePendingRunMessage(
  host: ChatQueueScopedSessionHost,
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
  // Local commands join an existing run without a wire chat.send, so this
  // pending row intentionally has no fake send identity.
  const item: ChatQueueItem = {
    id: generateUUID(),
    text: trimmed,
    createdAt: Date.now(),
    attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
    pendingRunId,
    ...(sender ? { sender } : {}),
  };
  keepVolatileQueuedMessage(host, host.sessionKey, item);
}

export function readChatQueueForScope(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  agentId?: string,
): ChatQueueItem[] {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId);
  return chatOutboxOwner(host).snapshot(host, scope);
}

function writeChatQueueForScope(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  queue: ChatQueueItem[],
  agentId?: string,
  options: { requestUpdate?: boolean } = {},
) {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId);
  chatOutboxOwner(host).replace(host, scope, queue, options);
}

export function readQueuedMessageById(
  host: ChatQueueScopedSessionHost,
  id: string,
): ChatQueueItem | null {
  return (
    chatOutboxOwner(host)
      .allItems(host)
      .find((item) => item.id === id) ?? null
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
  options: { retryable?: boolean } = {},
): ChatQueueItem | null {
  return chatOutboxOwner(host).change(host, id, update, options.retryable);
}

export function updateQueuedMessageForSession(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
  agentId?: string,
): ChatQueueItem | null {
  const owner = chatOutboxOwner(host);
  const stored = owner.durable(host, id);
  const scope: StoredChatOutboxScope =
    stored ?? resolveStoredChatOutboxScope(host, sessionKey, agentId);
  const storedItem = stored?.queue.find((item) => item.id === id);
  const current = owner.allItems(host).find((item) => item.id === id) ?? storedItem;
  if (!current) {
    return null;
  }
  const nextItem = update(current);
  if (!stored) {
    return owner.change(host, id, () => nextItem);
  }
  if (
    !updateStoredChatComposerQueueItem(
      host,
      stored.sessionKey,
      current,
      nextItem,
      stored.agentId ?? current.agentId ?? nextItem.agentId,
    )
  ) {
    if (!isProcessLiveQueueProjection(nextItem)) {
      owner.projectLive(host, scope, id);
    } else {
      owner.syncHost(host);
    }
    return null;
  }
  if (nextItem.sendState === "waiting-model") {
    owner.keep(host, scope, nextItem);
  } else {
    owner.change(host, id);
  }
  if (isProcessLiveQueueProjection(nextItem)) {
    owner.projectLive(host, scope, id, nextItem);
  } else {
    owner.projectLive(host, scope, id);
  }
  return nextItem;
}

/**
 * Applies every update as one durable unit instead of one write per row, so a
 * multi-row permutation (a reorder) can never persist partially. Rows already
 * in a stored outbox share that outbox's single batch write; rows still
 * volatile-only apply directly in memory since they never touch storage.
 * Every id in `updates` comes from one caller-resolved scope, so any durable
 * rows among them share one outbox.
 */
type QueuedMessageMoveRow = {
  id: string;
  stored: StoredChatOutbox | undefined;
  current: ChatQueueItem;
  next: ChatQueueItem;
};

export function updateQueuedMessagesForSession(
  host: ChatQueueScopedSessionHost,
  updates: readonly { id: string; update: (item: ChatQueueItem) => ChatQueueItem }[],
): boolean {
  const owner = chatOutboxOwner(host);
  const rows: QueuedMessageMoveRow[] = [];
  for (const { id, update } of updates) {
    const stored = owner.durable(host, id);
    const storedItem = stored?.queue.find((item) => item.id === id);
    const current = owner.allItems(host).find((item) => item.id === id) ?? storedItem;
    if (!current) {
      return false;
    }
    rows.push({ id, stored, current, next: update(current) });
  }
  const durableRows = rows.filter((row) => row.stored);
  const outbox = durableRows[0]?.stored;
  if (outbox) {
    const applied = updateStoredChatComposerQueueItems(
      host,
      outbox.sessionKey,
      durableRows.map((row) => ({ expected: row.current, next: row.next })),
      outbox.agentId,
    );
    for (const row of durableRows) {
      if (applied) {
        owner.change(host, row.id);
      }
      owner.projectLive(host, outbox, row.id);
    }
    if (!applied) {
      return false;
    }
  }
  for (const row of rows) {
    if (!row.stored) {
      owner.change(host, row.id, () => row.next);
    }
  }
  return true;
}

/**
 * `replaces` admits the item as the stored replacement for another row, which
 * retires the source in the same write. A rejected write changes nothing, so an
 * edited message can never lose both its original and its replacement.
 */
export function admitQueuedMessageForSession(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
  item: ChatQueueItem,
  replaces?: StoredChatQueueReplacement,
): boolean {
  const owner = chatOutboxOwner(host);
  const scope = resolveStoredChatOutboxScope(host, sessionKey, item.agentId);
  owner.keep(host, scope, item);
  if (!admitStoredChatComposerQueueItem(host, sessionKey, item, item.agentId, replaces)) {
    return false;
  }
  if (item.sendState !== "waiting-model") {
    owner.change(host, item.id);
  }
  return owner.durable(host, item.id) !== undefined;
}

export function removeQueuedMessageWithoutReleasing(
  host: ChatQueueScopedSessionHost,
  id: string,
  sessionKey = host.sessionKey,
  agentId?: string,
): ChatQueueItem | null {
  const owner = chatOutboxOwner(host);
  const stored = owner.durable(host, id);
  const scope: StoredChatOutboxScope =
    stored ?? resolveStoredChatOutboxScope(host, sessionKey, agentId);
  const storedItem = stored?.queue.find((entry) => entry.id === id) ?? null;
  const item = owner.allItems(host).find((entry) => entry.id === id) ?? storedItem;
  if (item && !owner.mayRemove(host, scope, id)) {
    owner.syncHost(host);
    return null;
  }
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
    owner.syncHost(host);
    return null;
  }
  if (item) {
    owner.projectLive(host, scope, id);
    owner.change(host, id);
  }
  owner.publish(undefined, true);
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
  const item = readQueuedMessageById(host, id);
  const removed = item ? removeQueuedMessageWithoutReleasing(host, id) : null;
  if (removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
  return removed ? ("removed" as const) : item ? ("rejected" as const) : ("absent" as const);
}

export function removeDeliveredQueuedChatSendForRun(
  host: ChatQueueScopedSessionHost,
  runId: string | undefined,
  scope: StoredChatOutboxScope,
): ChatQueueItem | null {
  const match = readDeliveredQueuedChatSendForRun(host, runId, scope);
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
  scope: StoredChatOutboxScope,
): { item: ChatQueueItem; outbox: StoredChatOutbox } | null {
  if (!runId) {
    return null;
  }
  const scopeKey = storedChatOutboxScopeKey(scope);
  const outbox = listStoredChatOutboxes(host).find(
    (candidate) => storedChatOutboxScopeKey(candidate) === scopeKey,
  );
  const item = outbox?.queue.find((candidate) => candidate.sendRunId === runId);
  return item && outbox ? { item, outbox } : null;
}

export function clearPendingQueueItemsForRun(
  host: ChatQueueScopedSessionHost,
  runId: string | undefined,
) {
  if (!runId) {
    return;
  }
  const removed = host.chatQueue.filter((item) => item.pendingRunId === runId);
  writeChatQueueForScope(
    host,
    host.sessionKey,
    host.chatQueue.filter((item) => item.pendingRunId !== runId),
  );
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
}

export function markQueuedChatSendsWaitingForReconnect(host: ChatQueueScopedSessionHost) {
  const items = chatOutboxOwner(host).allItems(host);
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
