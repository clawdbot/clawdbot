import type {
  ApplicationInitialUserMessage,
  ApplicationInitialUserMessageHandoff,
} from "../../app/context.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  markLocalRecoveryItem,
  markVolatileQueuedMessage,
  readChatQueueForScope,
  type ChatQueueScopedSessionHost,
  writeChatQueueForScope,
} from "./chat-queue.ts";
import { messageDisplaySignature } from "./history-merge.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

const INITIAL_TURN_HANDOFF_TTL_MS = 60_000;

type InitialTurnHandoff = {
  item: ChatQueueItem;
  sessionKey: string;
  timer: ReturnType<typeof globalThis.setTimeout>;
};

let pending: InitialTurnHandoff | null = null;

function clearPending(releaseAttachments: boolean): void {
  if (!pending) {
    return;
  }
  globalThis.clearTimeout(pending.timer);
  if (releaseAttachments) {
    releaseChatAttachmentPayloads(pending.item.attachments ?? []);
  }
  pending = null;
}

/** Hands one storage-rejected initial turn to the chat route that owns its created session. */
export function prepareInitialTurnHandoff(sessionKey: string, item: ChatQueueItem): void {
  clearPending(true);
  const timer = globalThis.setTimeout(() => clearPending(true), INITIAL_TURN_HANDOFF_TTL_MS);
  pending = { item, sessionKey, timer };
}

/** Hands the accepted first prompt to chat before transcript persistence catches up. */
export function prepareInitialUserMessageHandoff(
  handoff: ApplicationInitialUserMessageHandoff,
  sessionKey: string,
  item: Pick<ChatQueueItem, "attachments" | "createdAt" | "text">,
  owner: object,
): void {
  const durableAttachments = item.attachments?.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return dataUrl ? { ...attachment, dataUrl, previewUrl: dataUrl } : attachment;
  });
  const message: ApplicationInitialUserMessage = {
    role: "user",
    content: buildUserChatMessageContentBlocks(item.text, durableAttachments),
    timestamp: item.createdAt,
  };
  // Keep the projection until terminal history owns it so active first turns
  // survive later pane/history resets.
  handoff.prepare({ message, owner, sessionKey });
}

function consumeInitialTurnHandoff(sessionKey: string): ChatQueueItem | null {
  if (!pending || !areUiSessionKeysEquivalent(pending.sessionKey, sessionKey)) {
    return null;
  }
  const item = pending.item;
  clearPending(false);
  return item;
}

export function admitInitialTurnHandoff(
  host: ChatQueueScopedSessionHost,
  sessionKey: string,
): boolean {
  const item = consumeInitialTurnHandoff(sessionKey);
  if (!item) {
    return false;
  }
  const queue = readChatQueueForScope(host, sessionKey, item.agentId);
  if (!queue.some((entry) => entry.id === item.id)) {
    writeChatQueueForScope(host, sessionKey, [...queue, item], item.agentId);
  }
  markLocalRecoveryItem(host, item.id);
  markVolatileQueuedMessage(host, item.id);
  return true;
}

export function admitInitialUserMessageHandoff(
  handoff: ApplicationInitialUserMessageHandoff,
  host: { chatMessages: unknown[]; hello?: object | null },
  sessionKey: string,
): boolean {
  const message = handoff.read(sessionKey, host.hello ?? null);
  if (!message) {
    return false;
  }
  const signature = messageDisplaySignature(message);
  const matchingMessage = host.chatMessages.find(
    (candidate) => signature && messageDisplaySignature(candidate) === signature,
  );
  if (matchingMessage) {
    return false;
  }
  host.chatMessages = [message, ...host.chatMessages];
  return true;
}

/** Keeps the accepted prompt projected until authoritative history owns it. */
export function reconcileInitialUserMessageHandoff(
  handoff: ApplicationInitialUserMessageHandoff,
  host: { chatMessages: unknown[]; hello?: object | null },
  sessionKey: string,
  authoritativeMessages: unknown[],
  runActive: boolean,
): boolean {
  const message = handoff.read(sessionKey, host.hello ?? null);
  if (!message) {
    return false;
  }
  const signature = messageDisplaySignature(message);
  const historyOwnsMessage = authoritativeMessages.some(
    (candidate) => signature && messageDisplaySignature(candidate) === signature,
  );
  if (historyOwnsMessage && !runActive) {
    handoff.clear(sessionKey);
    return false;
  }
  return admitInitialUserMessageHandoff(handoff, host, sessionKey);
}
