// Telegram plugin module implements reasoning lane coordinator behavior.
import { formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findCodeRegions, isInsideCode } from "openclaw/plugin-sdk/text-chunking";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";

// A durable reasoning message already marked channel-side: 🧠 + italic body
// (see markReasoningMessage). Detect it so a re-split passes it through
// unchanged instead of re-marking.
const REASONING_MESSAGE_RE = /^🧠\s+_/u;
// Core's formatReasoningMessage prefixes the italic body with a literal
// "Thinking" header. Telegram renders durable thoughts with the 🧠 marker
// (Discord parity), so this header must be rewritten channel-side.
const CORE_THINKING_HEADER_RE = /^Thinking\.{0,3}\s*\n+/u;
const LEGACY_REASONING_MESSAGE_PREFIX = "Reasoning:\n";

// Rewrite core's "Thinking\n\n_body_" into "🧠 _body_": strip the header word
// and prefix the first italic line with 🧠. Keeps the italic body intact so
// Telegram HTML renders it as before.
function markReasoningMessage(formatted: string): string {
  const withoutHeader = formatted.replace(CORE_THINKING_HEADER_RE, "");
  return withoutHeader.replace(/^_/u, "🧠 _");
}
const REASONING_TAG_PREFIXES = [
  "<think",
  "<thinking",
  "<thought",
  "<antthinking",
  "<mm:think",
  "</think",
  "</thinking",
  "</thought",
  "</antthinking",
  "</mm:think",
];
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;

function extractThinkingFromTaggedStreamOutsideCode(text: string): string {
  if (!text) {
    return "";
  }
  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  THINKING_TAG_RE.lastIndex = 0;
  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const isClose = match[1] === "/";
    inThinking = !isClose;
    lastIndex = idx + match[0].length;
  }
  if (inThinking) {
    result += text.slice(lastIndex);
  }
  return result.trim();
}

function isPartialReasoningTagPrefix(text: string): boolean {
  const trimmed = normalizeLowercaseStringOrEmpty(text.trimStart());
  if (!trimmed.startsWith("<")) {
    return false;
  }
  if (trimmed.includes(">")) {
    return false;
  }
  return REASONING_TAG_PREFIXES.some((prefix) => prefix.startsWith(trimmed));
}

type TelegramReasoningSplit = {
  reasoningText?: string;
  answerText?: string;
};

export function splitTelegramReasoningText(
  text?: string,
  isReasoning?: boolean,
): TelegramReasoningSplit {
  if (typeof text !== "string") {
    return {};
  }

  if (isReasoning !== true) {
    return { answerText: text };
  }

  const trimmed = text.trim();
  if (isPartialReasoningTagPrefix(trimmed)) {
    return {};
  }
  if (REASONING_MESSAGE_RE.test(trimmed)) {
    return { reasoningText: trimmed };
  }
  // Durable reasoning payloads arrive pre-formatted by core with the "Thinking"
  // header; rewrite that to the 🧠 marker rather than passing it through.
  if (CORE_THINKING_HEADER_RE.test(trimmed)) {
    return { reasoningText: markReasoningMessage(trimmed) };
  }
  if (
    trimmed.startsWith(LEGACY_REASONING_MESSAGE_PREFIX) &&
    trimmed.length > LEGACY_REASONING_MESSAGE_PREFIX.length
  ) {
    return { reasoningText: trimmed };
  }

  const taggedReasoning = extractThinkingFromTaggedStreamOutsideCode(text);
  const strippedAnswer = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });

  return {
    reasoningText: markReasoningMessage(
      formatReasoningMessage(taggedReasoning || strippedAnswer || text),
    ),
  };
}

type BufferedFinalAnswer = {
  payload: ReplyPayload;
  text: string;
  bufferedGeneration?: number;
};

export function createTelegramReasoningStepState() {
  let reasoningStatus: "none" | "hinted" | "delivered" = "none";
  let bufferedFinalAnswer: BufferedFinalAnswer | undefined;

  const noteReasoningHint = () => {
    if (reasoningStatus === "none") {
      reasoningStatus = "hinted";
    }
  };

  const noteReasoningDelivered = () => {
    reasoningStatus = "delivered";
  };

  const shouldBufferFinalAnswer = () => {
    return reasoningStatus === "hinted" && !bufferedFinalAnswer;
  };

  const bufferFinalAnswer = (value: BufferedFinalAnswer) => {
    bufferedFinalAnswer = value;
  };

  const takeBufferedFinalAnswer = (currentGeneration?: number): BufferedFinalAnswer | undefined => {
    if (
      currentGeneration !== undefined &&
      bufferedFinalAnswer?.bufferedGeneration !== undefined &&
      bufferedFinalAnswer.bufferedGeneration !== currentGeneration
    ) {
      return undefined;
    }
    const value = bufferedFinalAnswer;
    bufferedFinalAnswer = undefined;
    return value;
  };

  const resetForNextStep = () => {
    reasoningStatus = "none";
    bufferedFinalAnswer = undefined;
  };

  return {
    noteReasoningHint,
    noteReasoningDelivered,
    shouldBufferFinalAnswer,
    bufferFinalAnswer,
    takeBufferedFinalAnswer,
    resetForNextStep,
  };
}
