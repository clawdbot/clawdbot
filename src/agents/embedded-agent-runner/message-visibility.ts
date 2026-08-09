import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../../auto-reply/tokens.js";
import { resolveAssistantMessagePhase } from "../../shared/chat-message-content.js";

type AgentPayloadLike = {
  text?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  presentation?: unknown;
  interactive?: unknown;
  channelData?: unknown;
  attachments?: unknown;
  isError?: unknown;
  isReasoning?: unknown;
  visible?: unknown;
};

type PayloadVisibilityOptions = {
  includeErrorPayloads?: boolean;
  includeReasoningPayloads?: boolean;
  includeSilentReplyPayloads?: boolean;
};

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

function collectStringValues(value: unknown, output: Set<string>) {
  if (typeof value === "string" && value.trim()) {
    output.add(value.trim());
    return;
  }
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      output.add(entry.trim());
    }
  }
}

export function collectMediaUrlsFromRecord(
  record: Record<string, unknown>,
  output: Set<string>,
  // Payloads arrive as in-process `unknown` objects, so a malformed
  // self-referential `attachments` chain must not recurse indefinitely.
  seen = new WeakSet<object>(),
) {
  if (seen.has(record)) {
    return;
  }
  seen.add(record);
  collectStringValues(record.mediaUrl, output);
  collectStringValues(record.mediaUrls, output);
  collectStringValues(record.path, output);
  collectStringValues(record.url, output);
  collectStringValues(record.filePath, output);
  if (Array.isArray(record.attachments)) {
    for (const attachment of record.attachments) {
      if (attachment && typeof attachment === "object" && !Array.isArray(attachment)) {
        collectMediaUrlsFromRecord(attachment as Record<string, unknown>, output, seen);
      }
    }
  }
}

function hasVisibleAttachmentReference(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const urls = new Set<string>();
  for (const attachment of value) {
    if (attachment && typeof attachment === "object" && !Array.isArray(attachment)) {
      collectMediaUrlsFromRecord(attachment as Record<string, unknown>, urls);
    }
  }
  return urls.size > 0;
}

/** Applies the shared exact or payload-aware silent-reply contract. */
export function isSilentAgentReplyText(
  value: unknown,
  mode: "exact" | "payload" = "exact",
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return mode === "payload"
    ? isSilentReplyPayloadText(value, SILENT_REPLY_TOKEN)
    : isSilentReplyText(value, SILENT_REPLY_TOKEN);
}

/** Returns whether payload metadata contains user-visible content. */
export function hasVisibleAgentPayload(
  result: { payloads?: unknown },
  options: PayloadVisibilityOptions = {},
): boolean {
  return (
    Array.isArray(result.payloads) &&
    result.payloads.some((payload) => {
      if (!payload || typeof payload !== "object") {
        return false;
      }
      const record = payload as AgentPayloadLike;
      if (options.includeErrorPayloads === false && record.isError === true) {
        return false;
      }
      if (options.includeReasoningPayloads === false && record.isReasoning === true) {
        return false;
      }
      const visibleText =
        hasNonEmptyString(record.text) &&
        (options.includeSilentReplyPayloads !== false ||
          !isSilentAgentReplyText(record.text, "payload"));
      return Boolean(
        visibleText ||
        hasNonEmptyString(record.mediaUrl) ||
        hasNonEmptyStringArray(record.mediaUrls) ||
        hasVisibleAttachmentReference(record.attachments) ||
        record.visible === true ||
        record.presentation ||
        record.interactive ||
        record.channelData,
      );
    })
  );
}

/** Returns whether a payload intentionally contains only the silent-reply marker. */
export function hasIntentionalSilentAgentPayload(result: { payloads?: unknown }): boolean {
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  return payloads.some((payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const record = payload as AgentPayloadLike;
    return (
      isSilentAgentReplyText(record.text, "payload") &&
      !hasVisibleAgentPayload({ payloads: [{ ...record, text: undefined }] })
    );
  });
}

/** Reads a transcript message role without trusting its boundary shape. */
export function getTranscriptMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/** Reads a committed final source-reply mirror from a transcript message. */
export function readTerminalSourceReplyDeliveryMirror(
  message: unknown,
): { sourceTurnId: string; toolCallId?: string } | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const marker = (message as { openclawDeliveryMirror?: unknown }).openclawDeliveryMirror;
  if (!marker || typeof marker !== "object") {
    return undefined;
  }
  const delivery = marker as Record<string, unknown>;
  const sourceTurnId =
    typeof delivery.sourceTurnId === "string" ? delivery.sourceTurnId.trim() : "";
  if (delivery.kind !== "message-tool-source-reply" || delivery.final !== true || !sourceTurnId) {
    return undefined;
  }
  const toolCallId = typeof delivery.toolCallId === "string" ? delivery.toolCallId.trim() : "";
  return { sourceTurnId, ...(toolCallId ? { toolCallId } : {}) };
}

/** System and malformed records do not constitute a resumable transcript tail. */
export function isMeaningfulTranscriptMessage(message: unknown): boolean {
  const role = getTranscriptMessageRole(message);
  return Boolean(role && role !== "system");
}

/** Recognizes persisted progress without mistaking an ordinary assistant answer for completion. */
export function isIntermediateAssistantTranscriptMessage(message: unknown): boolean {
  if (
    !message ||
    typeof message !== "object" ||
    getTranscriptMessageRole(message) !== "assistant"
  ) {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (record.stopReason !== undefined && record.stopReason !== "stop") {
    return false;
  }
  const phase = resolveAssistantMessagePhase(message);
  if (phase !== undefined) {
    return phase === "commentary";
  }
  const fallback = record.openclawStreamFallback;
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
    return false;
  }
  const { itemId, source } = fallback as { itemId?: unknown; source?: unknown };
  // Keyed segments are durable progress items; unkeyed/current fallbacks can
  // become the final answer and must never bypass restart completion checks.
  return source === "segment" && typeof itemId === "string" && itemId.trim().length > 0;
}

/** Returns whether a stopped assistant turn contains only reasoning and a silent marker. */
export function isTerminalSilentAssistantMessage(message: unknown): boolean {
  if (
    !message ||
    typeof message !== "object" ||
    getTranscriptMessageRole(message) !== "assistant" ||
    typeof (message as { stopReason?: unknown }).stopReason !== "string" ||
    (message as { stopReason: string }).stopReason.trim() !== "stop"
  ) {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as { type?: unknown; text?: unknown };
    const type = typeof record.type === "string" ? record.type.trim() : undefined;
    if (type === "thinking") {
      continue;
    }
    if (type !== "text") {
      return false;
    }
    if (typeof record.text === "string" && record.text.trim()) {
      textParts.push(record.text.trim());
    }
  }
  return isSilentAgentReplyText(textParts.join("\n"), "payload");
}
