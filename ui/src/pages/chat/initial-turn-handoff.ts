import type { ApplicationInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  keepVolatileQueuedMessage,
  readChatQueueForScope,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

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
  item: Pick<ChatQueueItem, "attachments" | "createdAt" | "sender" | "text">,
  owner: object,
  identity: { runId?: string; messageSeq?: number } = {},
): void {
  const runId = identity.runId?.trim();
  if (!runId) {
    return;
  }
  const durableAttachments = item.attachments?.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return dataUrl ? { ...attachment, dataUrl, previewUrl: dataUrl } : attachment;
  });
  const messageSequence =
    typeof identity.messageSeq === "number" &&
    Number.isSafeInteger(identity.messageSeq) &&
    identity.messageSeq > 0
      ? identity.messageSeq
      : undefined;
  const message = buildLocalUserMessage({
    text: item.text,
    attachments: durableAttachments,
    createdAt: item.createdAt,
    runId,
    ...(item.sender ? { sender: item.sender } : {}),
    ...(messageSequence === undefined ? {} : { sequence: messageSequence }),
  });
  if (!message) {
    return;
  }
  // This bounded process-local handoff owns the original inline bytes until
  // the pane projection adopts the matching authoritative row.
  handoff.prepare({
    message,
    owner,
    sessionKey,
    pendingRunId: runId,
  });
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
    keepVolatileQueuedMessage(host, sessionKey, item, item.agentId, { retryable: true });
  }
  return true;
}
