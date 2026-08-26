// Session memory transcript helpers persist compact session transcript excerpts.
import { classifySessionMessageOrigin } from "../../../../packages/memory-host-sdk/src/host/session-provenance.js";
import type { MemoryOriginClass } from "../../../../packages/memory-host-sdk/src/host/types.js";
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
  originClass: MemoryOriginClass;
  role: "assistant" | "user";
  text?: string;
};

type SessionMemoryMessageRenderResult = {
  message?: RenderedSessionMemoryMessage;
  turnOrigin: MemoryOriginClass;
};

function renderSessionMemoryMessage(
  entry: unknown,
  turnOrigin: MemoryOriginClass,
): SessionMemoryMessageRenderResult {
  if (!entry || typeof entry !== "object") {
    return { turnOrigin };
  }
  const record = entry as {
    message?: {
      content?: unknown;
      provenance?: unknown;
      role?: unknown;
    } & Record<string, unknown>;
    type?: unknown;
  };
  if (record.type !== "message" || !record.message) {
    return { turnOrigin };
  }
  const role = record.message.role;
  if ((role !== "user" && role !== "assistant") || !("content" in record.message)) {
    return { turnOrigin };
  }
  const nextTurnOrigin =
    role === "user" ? classifySessionMessageOrigin(record.message, turnOrigin) : turnOrigin;
  const originClass = classifySessionMessageOrigin(record.message, nextTurnOrigin);
  if (role === "user" && hasInterSessionUserProvenance(record.message)) {
    return { turnOrigin: nextTurnOrigin };
  }
  const text = extractTextMessageContent(record.message.content);
  const sanitized = text ? sanitizeSessionMemoryTranscriptText(text) : null;
  if (!sanitized) {
    return { turnOrigin: nextTurnOrigin };
  }
  if (sanitized.startsWith("/")) {
    return {
      turnOrigin: nextTurnOrigin,
      ...(role === "user" ? { message: { isDeliveryMirror: false, originClass, role } } : {}),
    };
  }
  return {
    turnOrigin: nextTurnOrigin,
    message: {
      isDeliveryMirror: isOpenClawDeliveryMirrorAssistantMessage(record.message),
      originClass,
      role,
      text: sanitized,
    },
  };
}

type SessionMemoryRecord = {
  line: string;
  originClass: MemoryOriginClass;
};

function renderSessionMemoryRecords(events: readonly unknown[]): SessionMemoryRecord[] {
  const allMessages: SessionMemoryRecord[] = [];
  let lastAssistantText: string | undefined;
  let turnOrigin: MemoryOriginClass = "untrusted";
  for (const event of events) {
    const result = renderSessionMemoryMessage(event, turnOrigin);
    turnOrigin = result.turnOrigin;
    const rendered = result.message;
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
    allMessages.push({
      line: `${rendered.role}: ${quoteSessionMemoryText(rendered.text)}`,
      originClass: rendered.originClass,
    });
    if (rendered.role === "assistant") {
      lastAssistantText = rendered.text;
    }
  }
  return allMessages;
}

/** Counts transcript events that remain after session-memory filtering and deduplication. */
export function countSessionMemoryMessages(events: readonly unknown[]): number {
  return renderSessionMemoryRecords(events).length;
}

export type SessionMemoryProjection = {
  content: string;
  originClass: "agent" | "untrusted";
};

export function getRecentSessionProjectionFromEvents(
  events: readonly unknown[],
  messageCount = 15,
): SessionMemoryProjection | null {
  const limit = Number.isFinite(messageCount) ? Math.max(0, Math.floor(messageCount)) : 0;
  if (limit === 0) {
    return null;
  }
  const records = renderSessionMemoryRecords(events).slice(-limit);
  if (records.length === 0) {
    return null;
  }
  return {
    content: records.map((record) => record.line).join("\n"),
    originClass: records.some(
      (record) => record.originClass === "untrusted" || record.originClass === "system",
    )
      ? "untrusted"
      : "agent",
  };
}
