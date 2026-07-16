// QA channel protocol helpers validate synthetic channel messages used by QA plugins.
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";

/** Conversation shape supported by the synthetic QA channel bus. */
export type QaBusConversationKind = "direct" | "channel" | "group";

/** Parsed QA channel target with case-preserving conversation identifiers. */
export type QaTargetParts = {
  chatType: QaBusConversationKind;
  conversationId: string;
  threadId?: string;
};

/** Parse the lowercase, prefix-scoped target grammar shared by QA Channel and QA Lab. */
export function parseQaTarget(
  raw: string,
  options?: { defaultChatType?: QaBusConversationKind },
): QaTargetParts {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error("qa-channel target is required");
  }
  const prefixed = /^(thread|channel|group|dm):(.*)$/u.exec(normalized);
  if (!prefixed && /^(thread|channel|group|dm):/iu.test(normalized)) {
    throw new Error(`qa-channel target prefixes must be lowercase: ${normalized}`);
  }
  const prefix = prefixed?.[1];
  const rest = prefixed?.[2]?.trim();
  if (prefix === "thread") {
    if (!rest) {
      throw new Error(`invalid qa-channel thread target: ${normalized}`);
    }
    const slashIndex = rest.indexOf("/");
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      throw new Error(`invalid qa-channel thread target: ${normalized}`);
    }
    const conversationId = rest.slice(0, slashIndex).trim();
    const threadId = rest.slice(slashIndex + 1).trim();
    if (!conversationId || !threadId) {
      throw new Error(`invalid qa-channel thread target: ${normalized}`);
    }
    return {
      chatType: "channel",
      conversationId,
      threadId,
    };
  }
  if (prefix) {
    if (!rest) {
      throw new Error(`invalid qa-channel ${prefix} target: ${normalized}`);
    }
    return {
      chatType: prefix === "dm" ? "direct" : prefix === "group" ? "group" : "channel",
      conversationId: rest,
    };
  }
  return {
    chatType: options?.defaultChatType ?? "direct",
    conversationId: normalized,
  };
}

/** Addressable conversation used by QA bus messages and thread state. */
export type QaBusConversation = {
  id: string;
  kind: QaBusConversationKind;
  title?: string;
};

/** Account-qualified conversation record returned in QA bus snapshots. */
export type QaBusSnapshotConversation = QaBusConversation & {
  accountId: string;
};

/** Media/file attachment fixture accepted by QA bus message APIs. */
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

/** Tool-call fixture attached to QA messages for agent-runtime tests. */
export type QaBusToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

/** Channel-native command metadata attached to a synthetic inbound message. */
export type QaBusNativeCommand = {
  name: string;
};

/** Stored QA bus message after defaults, reactions, and account ids are normalized. */
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
  nativeCommand?: QaBusNativeCommand;
  toolCalls?: QaBusToolCall[];
  reactions: Array<{
    emoji: string;
    senderId: string;
    timestamp: number;
  }>;
};

/** Synthetic thread record created inside a QA bus channel conversation. */
export type QaBusThread = {
  id: string;
  accountId: string;
  conversationId: string;
  title: string;
  createdAt: number;
  createdBy: string;
};

/** Ordered event emitted by QA bus polling and state snapshots. */
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

/** Input for injecting an inbound message from a synthetic user/channel. */
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
  nativeCommand?: QaBusNativeCommand;
  toolCalls?: QaBusToolCall[];
};

/** Input for recording an outbound message sent by an OpenClaw runtime. */
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

/** Input for creating a synthetic QA bus thread. */
export type QaBusCreateThreadInput = {
  accountId?: string;
  conversationId: string;
  title: string;
  createdBy?: string;
  timestamp?: number;
};

/** Input for adding a reaction event to an existing QA bus message. */
export type QaBusReactToMessageInput = {
  accountId?: string;
  messageId: string;
  emoji: string;
  senderId?: string;
  timestamp?: number;
};

/** Input for editing an existing QA bus message. */
export type QaBusEditMessageInput = {
  accountId?: string;
  messageId: string;
  text: string;
  timestamp?: number;
};

/** Input for marking an existing QA bus message as deleted. */
export type QaBusDeleteMessageInput = {
  accountId?: string;
  messageId: string;
  timestamp?: number;
};

/** Search filter accepted by QA bus message lookup helpers. */
export type QaBusSearchMessagesInput = {
  accountId?: string;
  query?: string;
  conversationId?: string;
  conversationKind?: QaBusConversationKind;
  /** Omit for any thread scope; use null for root-only results. */
  threadId?: string | null;
  limit?: number;
};

/** Lookup key for reading one QA bus message. */
export type QaBusReadMessageInput = {
  accountId?: string;
  messageId: string;
};

/** Cursor and timeout options used by QA bus polling. */
export type QaBusPollInput = {
  accountId?: string;
  cursor?: number;
  timeoutMs?: number;
  limit?: number;
};

/** Poll response containing the next cursor and ordered events. */
export type QaBusPollResult = {
  cursor: number;
  events: QaBusEvent[];
};

/** Complete QA bus state snapshot exposed to tests and diagnostics. */
export type QaBusStateSnapshot = {
  cursor: number;
  conversations: QaBusSnapshotConversation[];
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

/** Sanitize arbitrary tool-call arguments before storing them in QA bus messages. */
export function sanitizeQaBusToolCallArguments(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sanitized = sanitizeQaBusToolCallValue(value, 0);
  return isRecord(sanitized) ? sanitized : undefined;
}

/** Normalize and redact a bounded list of tool calls from untrusted QA input. */
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

/** Predicate input used by QA helpers that wait for bus events or messages. */
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
