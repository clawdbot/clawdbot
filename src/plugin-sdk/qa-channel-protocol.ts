export type QaBusConversationKind = "direct" | "channel" | "group";

export type QaBusConversation = {
  id: string;
  kind: QaBusConversationKind;
  title?: string;
};

export type QaBusAttachment = {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mimeType: string;
  fileName?: string;
  inline?: boolean;
  url?: string;
  contentBase64?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  transcript?: string;
};

export type QaBusToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type QaBusMessage = {
  id: string;
  accountId: string;
  direction: "inbound" | "outbound";
  conversation: QaBusConversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  threadId?: string;
  threadTitle?: string;
  replyToId?: string;
  deleted?: boolean;
  editedAt?: number;
  attachments?: QaBusAttachment[];
  toolCalls?: QaBusToolCall[];
  reactions: Array<{
    emoji: string;
    senderId: string;
    timestamp: number;
  }>;
};

export type QaBusThread = {
  id: string;
  accountId: string;
  conversationId: string;
  title: string;
  createdAt: number;
  createdBy: string;
};

export type QaBusEvent =
  | { cursor: number; kind: "inbound-message"; accountId: string; message: QaBusMessage }
  | { cursor: number; kind: "outbound-message"; accountId: string; message: QaBusMessage }
  | { cursor: number; kind: "thread-created"; accountId: string; thread: QaBusThread }
  | { cursor: number; kind: "message-edited"; accountId: string; message: QaBusMessage }
  | { cursor: number; kind: "message-deleted"; accountId: string; message: QaBusMessage }
  | {
      cursor: number;
      kind: "reaction-added";
      accountId: string;
      message: QaBusMessage;
      emoji: string;
      senderId: string;
    };

export type QaBusInboundMessageInput = {
  accountId?: string;
  conversation: QaBusConversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp?: number;
  threadId?: string;
  threadTitle?: string;
  replyToId?: string;
  attachments?: QaBusAttachment[];
  toolCalls?: QaBusToolCall[];
};

export type QaBusOutboundMessageInput = {
  accountId?: string;
  to: string;
  senderId?: string;
  senderName?: string;
  text: string;
  timestamp?: number;
  threadId?: string;
  replyToId?: string;
  attachments?: QaBusAttachment[];
  toolCalls?: QaBusToolCall[];
};

export type QaBusCreateThreadInput = {
  accountId?: string;
  conversationId: string;
  title: string;
  createdBy?: string;
  timestamp?: number;
};

export type QaBusReactToMessageInput = {
  accountId?: string;
  messageId: string;
  emoji: string;
  senderId?: string;
  timestamp?: number;
};

export type QaBusEditMessageInput = {
  accountId?: string;
  messageId: string;
  text: string;
  timestamp?: number;
};

export type QaBusDeleteMessageInput = {
  accountId?: string;
  messageId: string;
  timestamp?: number;
};

export type QaBusSearchMessagesInput = {
  accountId?: string;
  query?: string;
  conversationId?: string;
  threadId?: string;
  limit?: number;
};

export type QaBusReadMessageInput = {
  accountId?: string;
  messageId: string;
};

export type QaBusPollInput = {
  accountId?: string;
  cursor?: number;
  timeoutMs?: number;
  limit?: number;
};

export type QaBusPollResult = {
  cursor: number;
  events: QaBusEvent[];
};

export type QaBusStateSnapshot = {
  cursor: number;
  conversations: QaBusConversation[];
  threads: QaBusThread[];
  messages: QaBusMessage[];
  events: QaBusEvent[];
};

const QA_BUS_TOOL_CALL_MAX_COUNT = 50;
const QA_BUS_TOOL_CALL_MAX_DEPTH = 4;
const QA_BUS_TOOL_CALL_MAX_ARRAY_LENGTH = 20;
const QA_BUS_TOOL_CALL_MAX_OBJECT_KEYS = 40;
const QA_BUS_TOOL_CALL_REDACTED = "[redacted]";

const QA_BUS_TOOL_CALL_SENSITIVE_KEY_RE =
  /authorization|cookie|credential|password|secret|token|api[-_]?key|access[-_]?key|private[-_]?key/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeQaBusToolCallValue(value: unknown, depth: number, key?: string): unknown {
  if (key && QA_BUS_TOOL_CALL_SENSITIVE_KEY_RE.test(key)) {
    return QA_BUS_TOOL_CALL_REDACTED;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
  }
  if (typeof value === "string") {
    // Tool args often embed credentials in command/header/env shapes; keep structure, not raw text.
    return QA_BUS_TOOL_CALL_REDACTED;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= QA_BUS_TOOL_CALL_MAX_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, QA_BUS_TOOL_CALL_MAX_ARRAY_LENGTH).map((entry) => {
      return sanitizeQaBusToolCallValue(entry, depth + 1);
    });
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, QA_BUS_TOOL_CALL_MAX_OBJECT_KEYS)
        .flatMap(([entryKey, entryValue]) => {
          const sanitized = sanitizeQaBusToolCallValue(entryValue, depth + 1, entryKey);
          return sanitized === undefined ? [] : [[entryKey, sanitized]];
        }),
    );
  }
  return undefined;
}

export function sanitizeQaBusToolCallArguments(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sanitized = sanitizeQaBusToolCallValue(value, 0);
  return isRecord(sanitized) ? sanitized : undefined;
}

export function sanitizeQaBusToolCalls(value: unknown): QaBusToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sanitized = value.slice(0, QA_BUS_TOOL_CALL_MAX_COUNT).flatMap((toolCall) => {
    if (!isRecord(toolCall)) {
      return [];
    }
    const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
    if (!name) {
      return [];
    }
    const args = sanitizeQaBusToolCallArguments(toolCall.arguments);
    return [
      {
        name,
        ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
      },
    ];
  });
  return sanitized.length > 0 ? sanitized : undefined;
}

export type QaBusWaitForInput =
  | {
      timeoutMs?: number;
      kind: "event-kind";
      eventKind: QaBusEvent["kind"];
    }
  | {
      timeoutMs?: number;
      kind: "message-text";
      textIncludes: string;
      direction?: QaBusMessage["direction"];
    }
  | {
      timeoutMs?: number;
      kind: "thread-id";
      threadId: string;
    };
