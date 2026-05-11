import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  QaBusAttachment,
  QaBusConversation,
  QaBusEvent,
  QaBusMessage,
  QaBusPollInput,
  QaBusPollResult,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusThread,
} from "./runtime-api.js";

export const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(raw?: string): string {
  const trimmed = raw?.trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

export function normalizeConversationFromTarget(target: string): {
  conversation: QaBusConversation;
  threadId?: string;
} {
  const trimmed = target.trim();
  if (trimmed.startsWith("thread:")) {
    const rest = trimmed.slice("thread:".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      return {
        conversation: { id: rest.slice(0, slash), kind: "channel" },
        threadId: rest.slice(slash + 1),
      };
    }
  }
  if (trimmed.startsWith("channel:")) {
    return {
      conversation: { id: trimmed.slice("channel:".length), kind: "channel" },
    };
  }
  if (trimmed.startsWith("group:")) {
    return {
      conversation: { id: trimmed.slice("group:".length), kind: "group" },
    };
  }
  if (trimmed.startsWith("dm:")) {
    return {
      conversation: { id: trimmed.slice("dm:".length), kind: "direct" },
    };
  }
  return {
    conversation: { id: trimmed, kind: "direct" },
  };
}

export function cloneMessage(message: QaBusMessage): QaBusMessage {
  return {
    ...message,
    conversation: { ...message.conversation },
    attachments: (message.attachments ?? []).map((attachment) => cloneAttachment(attachment)),
    reactions: message.reactions.map((reaction) => ({ ...reaction })),
  };
}

function cloneAttachment(attachment: QaBusAttachment): QaBusAttachment {
  return { ...attachment };
}

export function cloneEvent(event: QaBusEvent): QaBusEvent {
  switch (event.kind) {
    case "inbound-message":
    case "outbound-message":
    case "message-edited":
    case "message-deleted":
    case "reaction-added":
      return { ...event, message: cloneMessage(event.message) };
    case "thread-created":
      return { ...event, thread: { ...event.thread } };
  }
  throw new Error("Unsupported QA bus event kind");
}

export function buildQaBusSnapshot(params: {
  cursor: number;
  conversations: Map<string, QaBusConversation>;
  threads: Map<string, QaBusThread>;
  messages: Map<string, QaBusMessage>;
  events: QaBusEvent[];
}): QaBusStateSnapshot {
  return {
    cursor: params.cursor,
    conversations: Array.from(params.conversations.values()).map((conversation) =>
      Object.assign({}, conversation),
    ),
    threads: Array.from(params.threads.values()).map((thread) => Object.assign({}, thread)),
    messages: Array.from(params.messages.values()).map((message) => cloneMessage(message)),
    events: params.events.map((event) => cloneEvent(event)),
  };
}

export function readQaBusMessage(params: {
  messages: Map<string, QaBusMessage>;
  input: QaBusReadMessageInput;
}) {
  const message = params.messages.get(params.input.messageId);
  if (!message) {
    throw new Error(`qa-bus message not found: ${params.input.messageId}`);
  }
  return cloneMessage(message);
}

export function searchQaBusMessages(params: {
  messages: Map<string, QaBusMessage>;
  input: QaBusSearchMessagesInput;
}) {
  const accountId = normalizeAccountId(params.input.accountId);
  const limit = Math.max(1, Math.min(params.input.limit ?? 20, 100));
  const query = normalizeOptionalLowercaseString(params.input.query);
  return Array.from(params.messages.values())
    .filter((message) => message.accountId === accountId)
    .filter((message) =>
      params.input.conversationId ? message.conversation.id === params.input.conversationId : true,
    )
    .filter((message) =>
      params.input.threadId ? message.threadId === params.input.threadId : true,
    )
    .filter((message) => {
      if (!query) {
        return true;
      }
      const attachmentHaystack = message.attachments ?? [];
      const searchableAttachmentText = attachmentHaystack
        .flatMap((attachment) => [
          attachment.fileName,
          attachment.altText,
          attachment.transcript,
          attachment.mimeType,
        ])
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase();
      const messageText = normalizeOptionalLowercaseString(message.text) ?? "";
      return `${messageText} ${searchableAttachmentText}`.includes(query);
    })
    .slice(-limit)
    .map((message) => cloneMessage(message));
}

export function pollQaBusEvents(params: {
  events: QaBusEvent[];
  cursor: number;
  input?: QaBusPollInput;
}): QaBusPollResult {
  const accountId = normalizeAccountId(params.input?.accountId);
  const startCursor = params.input?.cursor ?? 0;
  const effectiveStartCursor = params.cursor < startCursor ? 0 : startCursor;
  const limit = Math.max(1, Math.min(params.input?.limit ?? 100, 500));
  const matches = params.events
    .filter((event) => event.accountId === accountId && event.cursor > effectiveStartCursor)
    .slice(0, limit)
    .map((event) => cloneEvent(event));
  return {
    cursor: params.cursor,
    events: matches,
  };
}
