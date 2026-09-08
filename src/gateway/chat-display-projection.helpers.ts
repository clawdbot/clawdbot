import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isMeaningfulMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import { isRelativeAssistantMediaReference, splitMediaFromOutput } from "../media/parse.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

export type RoleContentMessage = {
  role: string;
  content?: unknown;
};

export const DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8_000;

/** Removes private yield inputs from a display copy without changing the source argument objects. */
export function stripPrivateToolCallContextForDisplay(entry: Record<string, unknown>): boolean {
  if (entry.type !== "toolCall" || entry.name !== "sessions_yield") {
    return false;
  }
  let changed = false;
  for (const field of ["arguments", "input"]) {
    const toolInput = readRecord(entry[field]);
    if (!toolInput || !("message" in toolInput)) {
      continue;
    }
    const { message: _, ...publicInput } = toolInput;
    entry[field] = publicInput;
    changed = true;
  }
  return changed;
}

export function takeAssistantManagedMediaUrlsForDisplay(
  entry: Record<string, unknown>,
  role: string,
): { changed: boolean; urls: string[] } {
  const delivery = role === "assistant" ? readRecord(entry.openclawDelivery) : undefined;
  const urls = Array.isArray(delivery?.mediaUrls)
    ? delivery.mediaUrls.filter((url): url is string => typeof url === "string")
    : [];
  if (!delivery || !Object.hasOwn(delivery, "mediaUrls")) {
    return { changed: false, urls };
  }
  const projectedDelivery = { ...delivery };
  delete projectedDelivery.mediaUrls;
  if (Object.keys(projectedDelivery).length > 0) {
    entry.openclawDelivery = projectedDelivery;
  } else {
    delete entry.openclawDelivery;
  }
  return { changed: true, urls };
}

/** Keeps managed attachment commands in the raw transcript while removing them from display text. */
export function stripAssistantMediaDirectivesForDisplay(
  text: string,
  managedMediaUrls: readonly string[],
): string {
  if (managedMediaUrls.length === 0 || !/(?:^|\n)\s*MEDIA:/iu.test(text)) {
    return text;
  }
  const managed = new Set(managedMediaUrls.map((url) => url.trim()).filter(Boolean));
  const parsed = splitMediaFromOutput(text, {
    extractAudioDirectives: false,
    extractMarkdownImages: false,
  });
  if (
    !parsed.mediaUrls?.some(
      (url) => isRelativeAssistantMediaReference(url) && managed.has(url.trim()),
    )
  ) {
    return text;
  }
  return (parsed.segments ?? [])
    .filter(
      (segment) =>
        segment.type !== "media" ||
        !isRelativeAssistantMediaReference(segment.url) ||
        !managed.has(segment.url.trim()),
    )
    .map((segment) => (segment.type === "media" ? `MEDIA:${segment.url}` : segment.text))
    .join("\n");
}

/** Resolve the text cap used when projecting chat history for display. */
export function resolveEffectiveChatHistoryMaxChars(_cfg: unknown, maxChars?: number): number {
  if (typeof maxChars === "number") {
    return maxChars;
  }
  return DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
}

export function truncateChatHistoryText(
  text: string,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${truncateUtf16Safe(text, maxChars)}\n...(truncated)...`,
    truncated: true,
  };
}

export function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (isAssistantInternalReasoningContentType(typed.type)) {
      continue;
    }
    if (!isAssistantTextContentType(typed.type) || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

export function isAssistantTextContentType(type: unknown): boolean {
  return type === "text" || type === "input_text" || type === "output_text";
}

export function isAssistantInternalReasoningContentType(type: unknown): boolean {
  return type === "thinking" || type === "reasoning" || type === "redacted_thinking";
}

export function hasAssistantNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      !isAssistantTextContentType((block as { type?: unknown }).type),
  );
}

export function hasAssistantDisplayableNonTextContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      !isAssistantTextContentType((block as { type?: unknown }).type) &&
      !isAssistantInternalReasoningContentType((block as { type?: unknown }).type),
  );
}

export function shouldPreserveAssistantControlReplyText(message: Record<string, unknown>): boolean {
  if (isProjectedSessionsSendForwardedMessage(message)) {
    return true;
  }
  if (!hasAssistantDisplayableNonTextContent(message)) {
    return false;
  }
  const content = message.text ?? message.content;
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((block) => {
            if (!block || typeof block !== "object" || Array.isArray(block)) {
              return [];
            }
            const typed = block as { type?: unknown; text?: unknown };
            return isAssistantTextContentType(typed.type) && typeof typed.text === "string"
              ? [typed.text]
              : [];
          })
        : [];
  return texts.length > 0 && texts.every((text) => isSuppressedControlReplyText(text));
}

export function asRoleContentMessage(message: Record<string, unknown>): RoleContentMessage | null {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (!role) {
    return null;
  }
  return {
    role,
    ...(message.content !== undefined
      ? { content: message.content }
      : message.text !== undefined
        ? { content: message.text }
        : {}),
  };
}

export function isEmptyTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  let sawText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string" || entry.text.trim().length > 0) {
      return false;
    }
  }
  return sawText;
}

export function hasTranscriptMediaFacts(message: Record<string, unknown>): boolean {
  return (readPersistedMediaFacts(message) ?? []).some(isMeaningfulMediaFact);
}

export function extractProjectedText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

export function isSessionsSendInterSessionUserMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "user") {
    return false;
  }
  const provenance = normalizeInputProvenance(message.provenance);
  return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
}

export function isProjectedSessionsSendForwardedMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const provenance = normalizeInputProvenance(message.provenance);
  return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
}
