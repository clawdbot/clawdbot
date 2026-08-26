import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { logLargePayload } from "../../logging/diagnostic-payload.js";

export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const CHAT_HISTORY_UNAVAILABLE_SENTINEL =
  "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";
let chatHistoryOmittedEmitCount = 0;

export function createChatHistoryByteCounter() {
  const sizes = new Map<unknown, number>();
  const messageBytes = (message: unknown): number => {
    const cached = sizes.get(message);
    if (cached !== undefined) {
      return cached;
    }
    const bytes = jsonUtf8Bytes(message);
    sizes.set(message, bytes);
    return bytes;
  };
  return {
    messageBytes,
    messagesBytes: (messages: unknown[]) =>
      2 +
      messages.reduce<number>((bytes, message) => bytes + messageBytes(message), 0) +
      Math.max(0, messages.length - 1),
  };
}

function buildChatHistoryUnavailableSentinel(): Record<string, unknown> {
  return {
    role: "assistant",
    timestamp: Date.now(),
    content: [{ type: "text", text: CHAT_HISTORY_UNAVAILABLE_SENTINEL }],
  };
}

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  const rawMetadata =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)["__openclaw"]
      : undefined;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const metadataId = typeof metadata.id === "string" ? metadata.id : undefined;
  const metadataSeq = typeof metadata.seq === "number" ? metadata.seq : undefined;
  const metadataIdempotencyKey =
    typeof metadata.idempotencyKey === "string" ? metadata.idempotencyKey : undefined;
  const turnBoundary = metadata.turnBoundary === true;
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: {
      ...(metadataId ? { id: metadataId } : {}),
      ...(metadataSeq !== undefined ? { seq: metadataSeq } : {}),
      ...(metadataIdempotencyKey ? { idempotencyKey: metadataIdempotencyKey } : {}),
      ...(turnBoundary ? { turnBoundary: true } : {}),
      truncated: true,
      reason: "oversized",
    },
  };
}

export function replaceOversizedChatHistoryMessages(params: {
  byteCounter?: ReturnType<typeof createChatHistoryByteCounter>;
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  const byteCounter = params.byteCounter ?? createChatHistoryByteCounter();
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (byteCounter.messageBytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    const placeholder = buildOversizedHistoryPlaceholder(message);
    return byteCounter.messageBytes(placeholder) <= maxSingleMessageBytes
      ? placeholder
      : buildChatHistoryUnavailableSentinel();
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

export function reportOmittedChatHistory(params: {
  originalMessages: unknown[];
  finalMessages: unknown[];
  getNormalizedBytes: () => number;
  maxHistoryBytes: number;
  logDebug: (message: string) => void;
}): number {
  const { originalMessages, finalMessages, getNormalizedBytes, maxHistoryBytes, logDebug } = params;
  const survivors = new Set(finalMessages);
  let omittedCount = 0;
  for (const message of originalMessages) {
    if (!survivors.has(message)) {
      omittedCount += 1;
    }
  }
  if (omittedCount === 0) {
    return 0;
  }
  chatHistoryOmittedEmitCount += omittedCount;
  logLargePayload({
    surface: "gateway.chat.history",
    action: "truncated",
    bytes: getNormalizedBytes(),
    limitBytes: maxHistoryBytes,
    count: omittedCount,
    reason: "chat_history_budget",
  });
  logDebug(
    `chat.history omitted oversized payloads count=${omittedCount} total=${chatHistoryOmittedEmitCount}`,
  );
  return omittedCount;
}
