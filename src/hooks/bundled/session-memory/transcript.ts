// Session memory transcript helpers persist compact session transcript excerpts.
import { sanitizeModelSpecialTokens } from "../../../security/external-content.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";

const SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX = String.raw`(?:(?:\|DSML\|)|(?:\uFF5CDSML\uFF5C))?`;
const SESSION_MEMORY_TOOL_DIRECTIVE_KIND = String.raw`(?:tool_calls?|function_calls?|tool_use_error)`;
const SESSION_MEMORY_DROP_BLOCK_RE = new RegExp(
  String.raw`<${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}\b[^>]*>` +
    String.raw`[\s\S]*?(?:<\/${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}>|$)`,
  "gi",
);
const SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE = /<(system|assistant|user)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE = /<\/?(?:system|assistant|user)\b[^>]*>/gi;
const SESSION_MEMORY_TRAILING_NO_REPLY_RE = /(?:^|\n)\s*NO_REPLY\s*$/i;
const SESSION_MEMORY_JSON_LINE_SEPARATOR_RE = /[\u0085\u2028\u2029]/gu;

function quoteSessionMemoryText(text: string): string {
  // One JSON string per role record keeps message text from forging later
  // records while preserving every character for memory readers.
  return JSON.stringify(text).replace(
    SESSION_MEMORY_JSON_LINE_SEPARATOR_RE,
    (separator) => `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function isNoReplyMarker(text: string): boolean {
  const trimmed = text.trim();
  return /^NO_REPLY$/i.test(trimmed) || /^\{\s*"action"\s*:\s*"NO_REPLY"\s*\}$/i.test(trimmed);
}

function sanitizeSessionMemoryTranscriptText(text: string): string | null {
  if (isNoReplyMarker(text)) {
    return null;
  }
  const withoutArtifacts = sanitizeModelSpecialTokens(text)
    .replace(SESSION_MEMORY_DROP_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE, "")
    .replace(SESSION_MEMORY_TRAILING_NO_REPLY_RE, "")
    .trim();

  return withoutArtifacts || null;
}

function extractTextMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return undefined;
}

type RenderedSessionMemoryMessage = {
  isDeliveryMirror: boolean;
  role: "assistant" | "user";
  text?: string;
};

function renderSessionMemoryMessage(entry: unknown): RenderedSessionMemoryMessage | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const record = entry as {
    message?: {
      content?: unknown;
      provenance?: unknown;
      role?: unknown;
    };
    type?: unknown;
  };
  if (record.type !== "message" || !record.message) {
    return undefined;
  }
  const role = record.message.role;
  if ((role !== "user" && role !== "assistant") || !("content" in record.message)) {
    return undefined;
  }
  if (role === "user" && hasInterSessionUserProvenance(record.message)) {
    return undefined;
  }
  const text = extractTextMessageContent(record.message.content);
  const sanitized = text ? sanitizeSessionMemoryTranscriptText(text) : null;
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.startsWith("/")) {
    return role === "user" ? { isDeliveryMirror: false, role } : undefined;
  }
  return {
    isDeliveryMirror: isOpenClawDeliveryMirrorAssistantMessage(record.message),
    role,
    text: sanitized,
  };
}

function renderSessionMemoryLines(events: readonly unknown[]): string[] {
  const allMessages: string[] = [];
  let lastAssistantText: string | undefined;
  for (const event of events) {
    const rendered = renderSessionMemoryMessage(event);
    if (!rendered) {
      continue;
    }
    if (rendered.role === "user") {
      // New turn: reset even when slash commands are omitted from memory, so
      // later standalone delivery mirrors are preserved.
      lastAssistantText = undefined;
    }
    if (!rendered.text) {
      continue;
    }
    // Skip delivery-mirror rows only when they duplicate the preceding
    // assistant text. Delivery-mirror rows with unique visible content
    // (e.g., message-tool replies) are preserved.
    if (rendered.isDeliveryMirror && rendered.text === lastAssistantText) {
      continue;
    }
    allMessages.push(`${rendered.role}: ${quoteSessionMemoryText(rendered.text)}`);
    if (rendered.role === "assistant") {
      lastAssistantText = rendered.text;
    }
  }
  return allMessages;
}

/** Counts transcript events that remain after session-memory filtering and deduplication. */
export function countSessionMemoryMessages(events: readonly unknown[]): number {
  return renderSessionMemoryLines(events).length;
}

/** Renders recent user/assistant transcript events into session memory text. */
export function getRecentSessionContentFromEvents(
  events: readonly unknown[],
  messageCount = 15,
): string | null {
  const limit = Number.isFinite(messageCount) ? Math.max(0, Math.floor(messageCount)) : 0;
  if (limit === 0) {
    return null;
  }
  const allMessages = renderSessionMemoryLines(events);
  return allMessages.slice(-limit).join("\n") || null;
}
