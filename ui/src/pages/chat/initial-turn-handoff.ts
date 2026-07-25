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
import { messageDisplaySignature, readTranscriptSequence } from "./history-merge.ts";
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
  identity: { messageId?: string; messageSeq?: number } = {},
): void {
  const durableAttachments = item.attachments?.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return dataUrl ? { ...attachment, dataUrl, previewUrl: dataUrl } : attachment;
  });
  const messageId = identity.messageId?.trim();
  const metadata = {
    ...(messageId ? { idempotencyKey: `${messageId}:user` } : {}),
    ...(identity.messageSeq !== undefined ? { seq: identity.messageSeq } : {}),
  };
  const hasMetadata = Boolean(messageId) || identity.messageSeq !== undefined;
  const message: ApplicationInitialUserMessage = {
    role: "user",
    // This bounded process-local handoff owns the durable bytes until
    // authoritative history adopts messageSeq, so the first row can render now.
    content: buildUserChatMessageContentBlocks(item.text, durableAttachments, {
      renderInlineImageDataUrls: true,
    }),
    timestamp: item.createdAt,
    ...(hasMetadata ? { __openclaw: metadata } : {}),
  };
  // Keep the projection until terminal history owns it so active first turns
  // survive later pane/history resets.
  handoff.prepare({ message, owner, sessionKey });
}

function isSameInitialUserMessage(candidate: unknown, message: ApplicationInitialUserMessage) {
  const sequence = readTranscriptSequence(message);
  if (sequence !== null && readTranscriptSequence(candidate) === sequence) {
    return true;
  }
  const signature = messageDisplaySignature(message);
  return Boolean(signature && messageDisplaySignature(candidate) === signature);
}

function hasInlineDataImage(message: ApplicationInitialUserMessage): boolean {
  return message.content.some((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return false;
    }
    const image = block as Record<string, unknown>;
    if (image.type !== "image") {
      return false;
    }
    if (typeof image.url === "string" && image.url.startsWith("data:image/")) {
      return true;
    }
    const source = image.source;
    return (
      source !== null &&
      typeof source === "object" &&
      !Array.isArray(source) &&
      typeof (source as Record<string, unknown>).url === "string" &&
      ((source as Record<string, unknown>).url as string).startsWith("data:image/")
    );
  });
}

function preserveInlineInitialImageProjection(
  host: { chatMessages: unknown[] },
  message: ApplicationInitialUserMessage,
): boolean {
  if (!hasInlineDataImage(message)) {
    return false;
  }
  const matchingIndex = host.chatMessages.findIndex((candidate) =>
    isSameInitialUserMessage(candidate, message),
  );
  if (matchingIndex < 0 || host.chatMessages[matchingIndex] === message) {
    return false;
  }
  const authoritative = host.chatMessages[matchingIndex];
  const authoritativeRecord =
    authoritative && typeof authoritative === "object" && !Array.isArray(authoritative)
      ? (authoritative as Record<string, unknown>)
      : {};
  const {
    MediaPath: _mediaPath,
    MediaPaths: _mediaPaths,
    MediaType: _mediaType,
    MediaTypes: _mediaTypes,
    content: _content,
    __openclaw: authoritativeMetadata,
    ...authoritativeFields
  } = authoritativeRecord;
  const normalizedAuthoritativeMetadata =
    authoritativeMetadata &&
    typeof authoritativeMetadata === "object" &&
    !Array.isArray(authoritativeMetadata)
      ? authoritativeMetadata
      : {};
  const nextMessages = [...host.chatMessages];
  // History persists attachments as local MediaPath entries. Keep the already
  // decoded inline projection for this page lifecycle so adopting history does
  // not change the <img> source and visibly flash the accepted first prompt.
  nextMessages[matchingIndex] = {
    ...message,
    ...authoritativeFields,
    content: message.content,
    __openclaw: {
      ...normalizedAuthoritativeMetadata,
      ...message["__openclaw"],
    },
  };
  host.chatMessages = nextMessages;
  return true;
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
  const matchingMessage = host.chatMessages.find((candidate) =>
    isSameInitialUserMessage(candidate, message),
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
  const historyOwnsMessage = authoritativeMessages.some((candidate) =>
    isSameInitialUserMessage(candidate, message),
  );
  if (historyOwnsMessage) {
    const projectionPreserved = preserveInlineInitialImageProjection(host, message);
    if (!runActive) {
      handoff.clear(sessionKey);
    }
    return projectionPreserved;
  }
  return admitInitialUserMessageHandoff(handoff, host, sessionKey);
}
