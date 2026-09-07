import { stripCompactionReplayCheckpointInPlace } from "@openclaw/ai/transports";
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
  assistantVisibleTextFilters,
  sanitizeAssistantVisibleTextWithProfile,
} from "../shared/text/assistant-visible-text.js";
import { createTextProjection, trimTextFilter } from "../shared/text/text-projection.js";
import {
  sanitizeUserFacingText,
  userFacingTextFilters,
} from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderUserFacingText } from "./embedded-agent-helpers/user-facing-text.js";
import type { AgentMessage } from "./runtime/index.js";

export { stripDowngradedToolCallText } from "../shared/text/assistant-visible-text.js";

/** Narrow an agent message to an assistant message. */
export function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage {
  return msg?.role === "assistant";
}

function sanitizeAssistantText(text: string, phase?: AssistantPhase, streaming = false): string {
  return sanitizeAssistantVisibleTextWithProfile(
    text,
    phase === "final_answer" ? "final-answer-delivery" : "delivery",
    streaming && phase === "final_answer",
  );
}

function isAssistantTextContentBlockType(value: unknown): boolean {
  return value === "text" || value === "input_text" || value === "output_text";
}

export function sanitizeAssistantVisibleStreamText(text: string, phase?: AssistantPhase): string {
  return sanitizeUserFacingText(sanitizeAssistantText(text, phase, true), { errorContext: false });
}

export function createAssistantVisibleStreamText(phase?: AssistantPhase) {
  return createTextProjection([
    ...assistantVisibleTextFilters(
      phase === "final_answer" ? "final-answer-delivery" : "delivery",
      phase === "final_answer",
    ),
    ...userFacingTextFilters(),
    trimTextFilter("both"),
  ]);
}

function finalizeAssistantExtraction(msg: AssistantMessage, extracted: string): string {
  const errorContext = msg.stopReason === "error";
  return errorContext
    ? renderUserFacingText(extracted, { errorContext: true })
    : sanitizeUserFacingText(extracted);
}

function extractEmbeddedAssistantTextForPhase(
  msg: AssistantMessage,
  requestedPhase: AssistantPhase,
  prepareText?: (
    text: string,
    final: boolean,
    phase?: AssistantPhase,
    contentIndex?: number,
  ) => string,
): string {
  const messagePhase = normalizeAssistantPhase((msg as { phase?: unknown }).phase);
  if (typeof msg.content === "string") {
    const selectedPhase =
      requestedPhase === "final_answer" && messagePhase !== "final_answer"
        ? undefined
        : requestedPhase;
    if (messagePhase !== selectedPhase) {
      return "";
    }
    const text = finalizeAssistantExtraction(
      msg,
      sanitizeAssistantText(
        prepareText ? prepareText(msg.content, true, messagePhase) : msg.content,
        messagePhase,
      ),
    );
    return selectedPhase === "final_answer" && !text.trim() ? "" : text;
  }
  if (!Array.isArray(msg.content)) {
    return "";
  }

  let hasExplicitPhasedTextBlocks = false;
  let hasFinalAnswerText = false;
  for (const block of msg.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentBlockType(record.type)) {
      continue;
    }
    const phase = parseAssistantTextSignature(record)?.phase;
    hasExplicitPhasedTextBlocks ||= Boolean(phase);
    hasFinalAnswerText ||= phase === "final_answer" && typeof record.text === "string";
    if (hasExplicitPhasedTextBlocks && (requestedPhase === "commentary" || hasFinalAnswerText)) {
      break;
    }
  }
  // An empty final text block still owns the answer; only absence allows unphased fallback.
  const selectedPhase =
    requestedPhase === "final_answer" &&
    !hasFinalAnswerText &&
    (hasExplicitPhasedTextBlocks || messagePhase !== "final_answer")
      ? undefined
      : requestedPhase;
  const parts: { text: string; phase?: AssistantPhase; contentIndex: number }[] = [];
  for (const [contentIndex, block] of msg.content.entries()) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentBlockType(record.type) || typeof record.text !== "string") {
      continue;
    }
    const signature = parseAssistantTextSignature(record);
    const resolvedPhase =
      signature?.phase ?? (hasExplicitPhasedTextBlocks ? undefined : messagePhase);
    if (resolvedPhase !== selectedPhase) {
      continue;
    }
    const sanitizerPhase =
      resolvedPhase ??
      (requestedPhase === "final_answer" && signature?.id ? "final_answer" : undefined);
    parts.push({ text: record.text, phase: sanitizerPhase, contentIndex });
  }
  const extracted = finalizeAssistantExtraction(
    msg,
    // A native block boundary can divide markup; finalize only the selected snapshot.
    parts
      .map(({ text, phase, contentIndex }, index) =>
        sanitizeAssistantText(
          prepareText ? prepareText(text, index === parts.length - 1, phase, contentIndex) : text,
          phase,
        ),
      )
      .filter((text) => text.trim())
      .join("\n")
      .trim(),
  );
  return selectedPhase === "final_answer" && !extracted.trim() ? "" : extracted;
}

/** Extract text intended for users, preferring explicit final-answer phase blocks. */
export function extractAssistantVisibleText(
  msg: AssistantMessage,
  prepareText?: (
    text: string,
    final: boolean,
    phase?: AssistantPhase,
    contentIndex?: number,
  ) => string,
): string {
  return extractEmbeddedAssistantTextForPhase(msg, "final_answer", prepareText);
}

/** Extract the commentary/narration text of a commentary-phase assistant message. */
export function extractAssistantCommentaryText(msg: AssistantMessage): string {
  return extractEmbeddedAssistantTextForPhase(msg, "commentary");
}

/** Extract sanitized assistant text across all text content blocks. */
export function extractEmbeddedAssistantText(msg: AssistantMessage): string {
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
  const blocks: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type: unknown = Reflect.get(block, "type");
    const rawThinking = Reflect.get(block, "thinking");
    if (type === "thinking" && typeof rawThinking === "string") {
      const thinking = rawThinking.trim();
      // Empty signed summaries produce no bubble; the original block still owns API replay.
      if (thinking) {
        blocks.push(thinking);
      }
    }
  }
  return blocks.join("\n");
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
/** Global regex used to scan provider-emitted thinking tags. */
export const THINKING_TAG_SCAN_RE = new RegExp(
  String.raw`<\s*(\/?)\s*${THINKING_TAG_NAME_PATTERN}\s*>`,
  "gi",
);
const THINKING_TAG_EXACT_RE = new RegExp(
  String.raw`^<\s*(\/?)\s*${THINKING_TAG_NAME_PATTERN}\s*>$`,
  "i",
);

export type ThinkingTagStreamState = {
  scannedOffset: number;
  pendingTagStart?: number;
  inThinking: boolean;
  extracted: string;
  lastMatchEnd: number;
  lastTag?: { type: "open" | "close"; end: number };
};

export function createThinkingTagStreamState(): ThinkingTagStreamState {
  return {
    scannedOffset: 0,
    inThinking: false,
    extracted: "",
    lastMatchEnd: 0,
  };
}

/** Split text that starts with thinking tags into structured thinking/text blocks. */
function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null {
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
  stripCompactionReplayCheckpointInPlace(message);
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

/** Incrementally extract thinking-tag content from a growing streaming payload. */
export function extractThinkingFromTaggedStream(
  text: string,
  state: ThinkingTagStreamState,
  delta: string,
): string {
  // Indexing the growing rope flattens the entire reply on each token. Scan the
  // appended chunk directly; a checkpoint reset still needs its unscanned prefix.
  const unscanned =
    text.length - state.scannedOffset === delta.length ? delta : text.slice(state.scannedOffset);
  for (let offset = 0; offset < unscanned.length; offset += 1) {
    const index = state.scannedOffset + offset;
    const char = unscanned[offset];
    if (char === "<") {
      state.pendingTagStart = index;
      continue;
    }
    if (char !== ">" || state.pendingTagStart === undefined) {
      continue;
    }
    const start = state.pendingTagStart;
    state.pendingTagStart = undefined;
    const match = THINKING_TAG_EXACT_RE.exec(text.slice(start, index + 1));
    if (!match) {
      continue;
    }
    if (state.inThinking) {
      state.extracted += text.slice(state.lastMatchEnd, start);
    }
    const isClose = match[1] === "/";
    state.inThinking = !isClose;
    state.lastMatchEnd = index + 1;
    state.lastTag = { type: isClose ? "close" : "open", end: index + 1 };
  }
  state.scannedOffset = text.length;

  const closed = state.extracted.trim();
  if (closed || state.lastTag?.type !== "open") {
    return closed;
  }
  return text.slice(state.lastTag.end).trim();
}
