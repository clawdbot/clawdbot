/**
 * Embedded-agent message text utilities.
 * Extracts visible assistant text, reasoning summaries, thinking-tag blocks,
 * and compact tool metadata for channel delivery and transcript replay.
 */
import type { AssistantMessage } from "../llm/types.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import {
  normalizeAssistantPhase,
  parseAssistantTextSignature,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
import {
  sanitizeAssistantFinalAnswerText,
  sanitizeAssistantVisibleText,
} from "../shared/text/assistant-visible-text.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import type { AgentMessage } from "./runtime/index.js";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

export {
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
} from "../shared/text/assistant-visible-text.js";
export { stripModelSpecialTokens } from "../shared/text/model-special-tokens.js";

/** Narrow an agent message to an assistant message. */
export function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage {
  return msg?.role === "assistant";
}

/**
 * Strip thinking tags and their content from text.
 * This is a safety net for cases where the model outputs <think> tags
 * that slip through other filtering mechanisms.
 */
export function stripThinkingTagsFromText(text: string): string {
  return stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
}

function sanitizeAssistantText(text: string, phase?: AssistantPhase): string {
  return phase === "final_answer"
    ? sanitizeAssistantFinalAnswerText(text)
    : sanitizeAssistantVisibleText(text);
}

function isAssistantTextContentBlockType(value: unknown): boolean {
  return value === "text" || value === "input_text" || value === "output_text";
}

export function sanitizeAssistantVisibleStreamText(text: string): string {
  return sanitizeUserFacingText(sanitizeAssistantText(text), { errorContext: false });
}

function finalizeAssistantExtraction(msg: AssistantMessage, extracted: string): string {
  const errorContext = msg.stopReason === "error";
  return sanitizeUserFacingText(extracted, { errorContext });
}

type AssistantTextExtractionResult = {
  text: string;
  hadRequestedPhase: boolean;
};

function extractAssistantTextForPhase(
  msg: AssistantMessage,
  phase?: AssistantPhase,
  options?: { unphasedSignedFinalAnswer?: boolean },
): AssistantTextExtractionResult {
  const messagePhase = normalizeAssistantPhase((msg as { phase?: unknown }).phase);
  const shouldIncludeContent = (resolvedPhase?: AssistantPhase) => {
    if (phase) {
      return resolvedPhase === phase;
    }
    return resolvedPhase === undefined;
  };

  if (typeof msg.content === "string") {
    const hadRequestedPhase = phase ? messagePhase === phase : messagePhase === undefined;
    return {
      text: shouldIncludeContent(messagePhase)
        ? finalizeAssistantExtraction(msg, sanitizeAssistantText(msg.content, messagePhase))
        : "",
      hadRequestedPhase,
    };
  }

  if (!Array.isArray(msg.content)) {
    return { text: "", hadRequestedPhase: false };
  }

  const hasExplicitPhasedTextBlocks = msg.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const record = block as { type?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentBlockType(record.type)) {
      return false;
    }
    return Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
  });

  let hadRequestedPhase = false;
  const parts = msg.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return null;
      }
      const record = block as { type?: unknown; text?: unknown; textSignature?: unknown };
      if (!isAssistantTextContentBlockType(record.type) || typeof record.text !== "string") {
        return null;
      }
      const signature = parseAssistantTextSignature(record.textSignature);
      const resolvedPhase =
        signature?.phase ?? (hasExplicitPhasedTextBlocks ? undefined : messagePhase);
      if (!shouldIncludeContent(resolvedPhase)) {
        return null;
      }
      hadRequestedPhase = true;
      const sanitizerPhase =
        resolvedPhase ??
        (options?.unphasedSignedFinalAnswer === true && signature?.id ? "final_answer" : undefined);
      const text = sanitizeAssistantText(record.text, sanitizerPhase);
      return text.trim() ? text : null;
    })
    .filter((value): value is string => typeof value === "string");
  const extracted = parts.join("\n").trim();

  return {
    text: finalizeAssistantExtraction(msg, extracted),
    hadRequestedPhase,
  };
}

/** Extract text intended for users, preferring explicit final-answer phase blocks. */
export function extractAssistantVisibleText(msg: AssistantMessage): string {
  const finalAnswerExtraction = extractAssistantTextForPhase(msg, "final_answer");
  if (finalAnswerExtraction.hadRequestedPhase) {
    return finalAnswerExtraction.text.trim() ? finalAnswerExtraction.text : "";
  }

  return extractAssistantTextForPhase(msg, undefined, { unphasedSignedFinalAnswer: true }).text;
}

/** Extract the commentary/narration text of a commentary-phase assistant message. */
export function extractAssistantCommentaryText(msg: AssistantMessage): string {
  return extractAssistantTextForPhase(msg, "commentary").text;
}

/** Extract sanitized assistant text across all text content blocks. */
export function extractAssistantText(msg: AssistantMessage): string {
  const extracted =
    extractTextFromChatContent(msg.content, {
      sanitizeText: (text) => sanitizeAssistantText(text),
      joinWith: "\n",
      normalizeText: (text) => text.trim(),
    }) ?? "";
  // Only apply keyword-based error rewrites when the assistant message is actually an error.
  // Otherwise normal prose that *mentions* errors (e.g. "context overflow") can get clobbered.
  // Gate on stopReason only — a non-error response with an errorMessage set (e.g. from a
  // background tool failure) should not have its content rewritten (#13935).
  return finalizeAssistantExtraction(msg, extracted);
}

/** Extract native thinking block text; signature-only blocks (no summary) surface nothing. */
export function extractAssistantThinking(msg: AssistantMessage): string {
  if (!Array.isArray(msg.content)) {
    return "";
  }
  const blocks = msg.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const record = block as unknown as Record<string, unknown>;
      if (record.type === "thinking" && typeof record.thinking === "string") {
        const thinking = record.thinking.trim();
        if (thinking) {
          return thinking;
        }
        // Signature-only thinking blocks carry a valid signature but no summary text
        // (e.g. Anthropic display:"omitted" on Opus 4.7+/Fable 5, or OpenAI/codex reasoning
        // items with encrypted_content and an empty summary). Surface nothing so the
        // .filter(Boolean) below drops the bubble — a diagnostic placeholder is not reasoning
        // content and must not be shown on any channel. The signed block stays on the message
        // for API replay; this only governs display.
        if (typeof record.thinkingSignature === "string" && record.thinkingSignature.trim()) {
          return "";
        }
      }
      return "";
    })
    .filter(Boolean);
  return blocks.join("\n").trim();
}

/** Format reasoning text for markdown-friendly channel surfaces. */
export function formatReasoningMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  // Show reasoning in italics (cursive) for markdown-friendly surfaces (Discord, etc.).
  // Keep a plain prefix so existing parsing/detection keeps working.
  // Note: Underscore markdown cannot span multiple lines on Telegram, so we wrap
  // each non-empty line separately.
  const italicLines = trimmed
    .split("\n")
    .map((line) => (line ? `_${line}_` : line))
    .join("\n");
  return `Thinking\n\n${italicLines}`;
}

type ThinkTaggedSplitBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string };

const THINKING_TAG_NAME_PATTERN = String.raw`(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)`;
const THINKING_TAG_OPEN_RE = new RegExp(String.raw`<\s*${THINKING_TAG_NAME_PATTERN}\s*>`, "i");
const THINKING_TAG_CLOSE_RE = new RegExp(
  String.raw`<\s*\/\s*${THINKING_TAG_NAME_PATTERN}\s*>`,
  "i",
);
const THINKING_TAG_OPEN_GLOBAL_RE = new RegExp(
  String.raw`<\s*${THINKING_TAG_NAME_PATTERN}\s*>`,
  "gi",
);
const THINKING_TAG_CLOSE_GLOBAL_RE = new RegExp(
  String.raw`<\s*\/\s*${THINKING_TAG_NAME_PATTERN}\s*>`,
  "gi",
);
/** Global regex used to scan provider-emitted thinking tags. */
export const THINKING_TAG_SCAN_RE = new RegExp(
  String.raw`<\s*(\/?)\s*${THINKING_TAG_NAME_PATTERN}\s*>`,
  "gi",
);

/** Split text that starts with thinking tags into structured thinking/text blocks. */
export function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null {
  const trimmedStart = text.trimStart();
  // Avoid false positives: only treat it as structured thinking when it begins
  // with a think tag (common for local/OpenAI-compat providers that emulate
  // reasoning blocks via tags).
  if (!trimmedStart.startsWith("<")) {
    return null;
  }
  if (!THINKING_TAG_OPEN_RE.test(trimmedStart)) {
    return null;
  }
  if (!THINKING_TAG_CLOSE_RE.test(text)) {
    return null;
  }

  let inThinking = false;
  let cursor = 0;
  let thinkingStart = 0;
  const blocks: ThinkTaggedSplitBlock[] = [];

  const pushText = (value: string) => {
    if (!value) {
      return;
    }
    blocks.push({ type: "text", text: value });
  };
  const pushThinking = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) {
      return;
    }
    blocks.push({ type: "thinking", thinking: cleaned });
  };

  for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
    const index = match.index ?? 0;
    const isClose = match[1]?.includes("/") ?? false;

    if (!inThinking && !isClose) {
      pushText(text.slice(cursor, index));
      thinkingStart = index + match[0].length;
      inThinking = true;
      continue;
    }

    if (inThinking && isClose) {
      pushThinking(text.slice(thinkingStart, index));
      cursor = index + match[0].length;
      inThinking = false;
    }
  }

  if (inThinking) {
    return null;
  }
  pushText(text.slice(cursor));

  const hasThinking = blocks.some((b) => b.type === "thinking");
  if (!hasThinking) {
    return null;
  }
  return blocks;
}

/** Promote inline thinking-tag text blocks into native thinking blocks in place. */
export function promoteThinkingTagsToBlocks(message: AssistantMessage): void {
  if (!Array.isArray(message.content)) {
    return;
  }
  const hasThinkingBlock = message.content.some(
    (block) => block && typeof block === "object" && block.type === "thinking",
  );
  if (hasThinkingBlock) {
    return;
  }

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of message.content) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      next.push(block);
      continue;
    }
    if (block.type !== "text") {
      next.push(block);
      continue;
    }
    const split = splitThinkingTaggedText(block.text);
    if (!split) {
      next.push(block);
      continue;
    }
    changed = true;
    for (const part of split) {
      if (part.type === "thinking") {
        next.push({ type: "thinking", thinking: part.thinking });
      } else if (part.type === "text") {
        const cleaned = part.text.trimStart();
        if (cleaned) {
          next.push({ type: "text", text: cleaned });
        }
      }
    }
  }

  if (!changed) {
    return;
  }
  message.content = next;
}

/** Extract closed thinking-tag content from a complete text payload. */
export function extractThinkingFromTaggedText(text: string): string {
  if (!text) {
    return "";
  }
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const isClose = match[1] === "/";
    inThinking = !isClose;
    lastIndex = idx + match[0].length;
  }
  return result.trim();
}

/** Extract thinking-tag content from a possibly incomplete streaming payload. */
export function extractThinkingFromTaggedStream(text: string): string {
  if (!text) {
    return "";
  }
  const closed = extractThinkingFromTaggedText(text);
  if (closed) {
    return closed;
  }

  const openMatches = [...text.matchAll(THINKING_TAG_OPEN_GLOBAL_RE)];
  if (openMatches.length === 0) {
    return "";
  }
  const closeMatches = [...text.matchAll(THINKING_TAG_CLOSE_GLOBAL_RE)];
  const lastOpen = openMatches.at(-1);
  const lastClose = closeMatches.at(-1);
  if (!lastOpen) {
    return "";
  }
  if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) {
    return closed;
  }
  const start = (lastOpen.index ?? 0) + lastOpen[0].length;
  return text.slice(start).trim();
}

/** Infer compact display metadata for a tool call from its args. */
export function inferToolMetaFromArgs(
  toolName: string,
  args: unknown,
  options?: { detailMode?: "explain" | "raw" },
): string | undefined {
  const display = resolveToolDisplay({ name: toolName, args, detailMode: options?.detailMode });
  return formatToolDetail(display);
}
