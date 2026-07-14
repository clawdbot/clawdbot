import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { logLargePayload } from "../../logging/diagnostic-payload.js";

export const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
const CHAT_HISTORY_UNAVAILABLE_SENTINEL =
  "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";
let chatHistoryOmittedEmitCount = 0;

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
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: {
      ...(metadataId ? { id: metadataId } : {}),
      ...(metadataSeq !== undefined ? { seq: metadataSeq } : {}),
      ...(metadataIdempotencyKey ? { idempotencyKey: metadataIdempotencyKey } : {}),
      truncated: true,
      reason: "oversized",
    },
  };
}

export function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0;
  const next = messages.map((message) => {
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

// Preserve a visible terminal record when the complete projected history cannot fit.
export function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last] };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder] };
  }
  return { messages: [buildChatHistoryUnavailableSentinel()] };
}

export function reportOmittedChatHistory(params: {
  originalMessages: unknown[];
  finalMessages: unknown[];
  normalizedBytes: number;
  maxHistoryBytes: number;
  logDebug: (message: string) => void;
}): number {
  const { originalMessages, finalMessages, normalizedBytes, maxHistoryBytes, logDebug } = params;
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
    bytes: normalizedBytes,
    limitBytes: maxHistoryBytes,
    count: omittedCount,
    reason: "chat_history_budget",
  });
  logDebug(
    `chat.history omitted oversized payloads count=${omittedCount} total=${chatHistoryOmittedEmitCount}`,
  );
  return omittedCount;
}
