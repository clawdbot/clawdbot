import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
// Control UI chat module implements message extract behavior.
import { stripInternalRuntimeContext } from "../../../../src/agents/internal-runtime-context.js";
import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { readPersistedMediaFacts } from "../../../../src/media/media-facts.js";
import { stripEnvelope } from "../../../../src/shared/chat-envelope.js";
import { extractAssistantPhaseText } from "../../../../src/shared/chat-message-content.js";
import { stripThinkingTags } from "../strip-thinking-tags.ts";
import { projectImportedMessageForDisplay } from "./imported-message-display.ts";

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

function isTextContentBlockType(value: unknown, role: string): boolean {
  return (
    value === "text" ||
    (role === "user" && value === "input_text") ||
    (role === "assistant" && (value === "input_text" || value === "output_text"))
  );
}

function processMessageText(text: string, role: string): string {
  const shouldStripInboundMetadata = normalizeLowercaseStringOrEmpty(role) === "user";
  const withoutInternalContext = stripInternalRuntimeContext(text);
  if (role === "assistant") {
    return stripThinkingTags(withoutInternalContext);
  }
  return shouldStripInboundMetadata
    ? stripInboundMetadata(stripEnvelope(withoutInternalContext))
    : stripEnvelope(withoutInternalContext);
}

export function extractText(message: unknown): string | null {
  // Chat events may carry no message at all (tool-only or heartbeat finals);
  // a nullish message means "no text", never a crash.
  if (message == null) {
    return null;
  }
  const projected = projectImportedMessageForDisplay(message);
  const m = projected as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const raw =
    role === "assistant" ? extractAssistantPhaseText(projected) : extractRawText(projected);
  if (!raw) {
    return null;
  }
  return processMessageText(raw, role);
}

export function extractTextCached(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return extractText(message);
  }
  const obj = message;
  if (textCache.has(obj)) {
    return textCache.get(obj) ?? null;
  }
  const value = extractText(message);
  textCache.set(obj, value);
  return value;
}

function extractThinking(message: unknown): string | null {
  if (message == null) {
    return null;
  }
  const m = message as Record<string, unknown>;
  const content = m.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      const item = asOptionalRecord(p);
      if (item?.type === "thinking" && typeof item.thinking === "string") {
        const cleaned = item.thinking.trim();
        if (cleaned) {
          parts.push(cleaned);
        }
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export function extractThinkingCached(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return extractThinking(message);
  }
  const obj = message;
  if (thinkingCache.has(obj)) {
    return thinkingCache.get(obj) ?? null;
  }
  const value = extractThinking(message);
  thinkingCache.set(obj, value);
  return value;
}

function extractRawText(message: unknown): string | null {
  if (message == null) {
    return null;
  }
  const m = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(m.role);
  const content = m.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = asOptionalRecord(p);
        if (item && isTextContentBlockType(item.type, role) && typeof item.text === "string") {
          return item.text;
        }
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof m.text === "string") {
    return m.text;
  }
  return null;
}

export function readTranscriptMediaEntries(message: unknown): Array<{
  factIndex: number;
  path: string;
  mediaType: string | undefined;
  fileName: string | undefined;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
}> {
  if (!message || typeof message !== "object") {
    return [];
  }
  return (readPersistedMediaFacts(message) ?? []).flatMap((fact, factIndex) => {
    const path = fact.path ?? fact.url;
    return path
      ? [
          {
            factIndex,
            path,
            mediaType: fact.contentType ?? fact.kind,
            fileName: fact.fileName,
            ...(fact.sizeBytes !== undefined ? { sizeBytes: fact.sizeBytes } : {}),
            ...(fact.durationMs !== undefined ? { durationMs: fact.durationMs } : {}),
            ...(fact.width !== undefined ? { width: fact.width } : {}),
            ...(fact.height !== undefined ? { height: fact.height } : {}),
          },
        ]
      : [];
  });
}

export function formatReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `_${line}_`);
  return lines.length ? ["_Reasoning:_", ...lines].join("\n") : "";
}

function isTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return true;
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
    if (typeof entry.text !== "string") {
      return false;
    }
  }
  return sawText;
}

/** True for user rows with no text and no media facts; such rows hide from history. */
export function isEmptyUserTextOnlyMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (normalizeLowercaseStringOrEmpty(entry.role) !== "user") {
    return false;
  }
  if (readTranscriptMediaEntries(entry).length > 0) {
    return false;
  }
  if (!isTextOnlyContent(entry.content ?? entry.text)) {
    return false;
  }
  return (extractText(message)?.trim() ?? "") === "";
}
