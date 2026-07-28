// Control UI page module owns Chat queue storage and queue item cleanup.
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { scopedAgentIdForSession, type SessionScopeHost } from "../../lib/sessions/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { cloneChatAttachmentsMetadata } from "./attachment-payload-store.ts";
import { persistStoredChatComposerQueue, type ChatComposerScope } from "./composer-persistence.ts";

type ChatQueueStoreHost = {
  chatQueue: ChatQueueItem[];
  chatQueueBySession?: Record<string, ChatQueueItem[]>;
  chatAttachments?: ChatAttachment[];
  requestUpdate?: () => void;
};

type ChatQueueSessionHost = ChatQueueStoreHost &
  ChatComposerScope & {
    sessionKey: string;
  };

type ChatQueueScopedSessionHost = ChatQueueSessionHost & SessionScopeHost;

export function enqueueChatMessage(
  host: ChatQueueScopedSessionHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
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
  };
  host.chatQueue = [...host.chatQueue, item];
  return item;
}

export function enqueuePendingRunMessage(
  host: ChatQueueSessionHost,
  text: string,
  pendingRunId: string,
  attachments?: ChatAttachment[],
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      kind: "steered",
      attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
      pendingRunId,
    },
  ];
}

export function readChatQueueForSession(
  host: ChatQueueSessionHost,
  sessionKey: string,
): ChatQueueItem[] {
  return sessionKey === host.sessionKey
    ? host.chatQueue
    : (host.chatQueueBySession?.[sessionKey] ?? []);
}

function writeChatQueueForSession(
  host: ChatQueueSessionHost,
  sessionKey: string,
  queue: ChatQueueItem[],
) {
  if (sessionKey === host.sessionKey) {
    host.chatQueue = queue;
    return;
  }
  const queueBySession = { ...host.chatQueueBySession };
  if (queue.length > 0) {
    queueBySession[sessionKey] = queue;
  } else {
    delete queueBySession[sessionKey];
  }
  host.chatQueueBySession = queueBySession;
  host.requestUpdate?.();
}

export function updateQueuedMessage(
  host: ChatQueueSessionHost,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  return updateQueuedMessageForSession(host, host.sessionKey, id, update);
}

export function updateQueuedMessageForSession(
  host: ChatQueueSessionHost,
  sessionKey: string,
  id: string,
  update: (item: ChatQueueItem) => ChatQueueItem,
): ChatQueueItem | null {
  let nextItem: ChatQueueItem | null = null;
  const nextQueue = readChatQueueForSession(host, sessionKey).map((item) => {
    if (item.id !== id) {
      return item;
    }
    nextItem = update(item);
    return nextItem;
  });
  writeChatQueueForSession(host, sessionKey, nextQueue);
  return nextItem;
}

export function persistQueuedMessagesForSession(host: ChatQueueSessionHost, sessionKey: string) {
  persistStoredChatComposerQueue(host, sessionKey, readChatQueueForSession(host, sessionKey));
}

export function removeQueuedMessageWithoutReleasing(
  host: ChatQueueSessionHost,
  id: string,
  sessionKey = host.sessionKey,
): ChatQueueItem | null {
  const queue = readChatQueueForSession(host, sessionKey);
  const item = queue.find((entry) => entry.id === id) ?? null;
  writeChatQueueForSession(
    host,
    sessionKey,
    queue.filter((entry) => entry.id !== id),
  );
  return item;
}

export function removeVisibleOrScopedQueuedMessageWithoutReleasing(
  host: ChatQueueSessionHost,
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

export function removeQueuedMessage(host: ChatQueueSessionHost, id: string) {
  const removed = host.chatQueue.filter((item) => item.id === id);
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
  for (const item of removed) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, item.attachments));
  }
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

export function markQueuedChatSendsWaitingForReconnect(host: ChatQueueStoreHost) {
  const markQueue = (queue: ChatQueueItem[]): { changed: boolean; queue: ChatQueueItem[] } => {
    let changed = false;
    const nextQueue = queue.map((item) => {
      if (!item.sendRunId || item.sendState !== "sending") {
        return item;
      }
      changed = true;
      return {
        ...item,
        sendState: "waiting-reconnect" as const,
      };
    });
    return { changed, queue: nextQueue };
  };

  const active = markQueue(host.chatQueue);
  if (active.changed) {
    host.chatQueue = active.queue;
  }

  let changed = false;
  const queueBySession = { ...host.chatQueueBySession };
  for (const [sessionKey, queue] of Object.entries(queueBySession)) {
    const next = markQueue(queue);
    if (next.changed) {
      changed = true;
      queueBySession[sessionKey] = next.queue;
    }
  }
  if (changed) {
    host.chatQueueBySession = queueBySession;
  }
}
