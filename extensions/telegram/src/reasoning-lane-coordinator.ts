import { formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { findCodeRegions, isInsideCode } from "openclaw/plugin-sdk/text-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  stripReasoningTagsFromText,
} from "openclaw/plugin-sdk/text-runtime";

const REASONING_MESSAGE_PREFIX = "Reasoning:\n";
const REASONING_TAG_PREFIXES = [
  "<think",
  "<thinking",
  "<thought",
  "<antthinking",
  "</think",
  "</thinking",
  "</thought",
  "</antthinking",
];
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

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

  const trimmed = text.trim();
  if (isPartialReasoningTagPrefix(trimmed)) {
    return {};
  }
  if (
    trimmed.startsWith(REASONING_MESSAGE_PREFIX) &&
    trimmed.length > REASONING_MESSAGE_PREFIX.length
  ) {
    return { reasoningText: trimmed };
  }

  const taggedReasoning = extractThinkingFromTaggedStreamOutsideCode(text);
  const strippedAnswer = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });

  if (isReasoning === true) {
    return { reasoningText: formatReasoningMessage(taggedReasoning || strippedAnswer || text) };
  }

  if (!taggedReasoning && strippedAnswer === text) {
    return { answerText: text };
  }

  const reasoningText = taggedReasoning ? formatReasoningMessage(taggedReasoning) : undefined;
  const answerText = strippedAnswer || undefined;
  return { reasoningText, answerText };
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
