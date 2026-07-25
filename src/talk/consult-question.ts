/**
 * Realtime voice consult-question extraction and result summarization helpers.
 *
 * These utilities connect Talk tool calls to spoken follow-up answers by
 * pulling human-readable questions/results out of provider-owned payloads.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readTrimmedStringAlias } from "../utils/string-readers.js";

const REALTIME_VOICE_CONSULT_QUESTION_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "check",
  "could",
  "for",
  "in",
  "is",
  "it",
  "look",
  "me",
  "of",
  "on",
  "or",
  "please",
  "see",
  "that",
  "the",
  "this",
  "to",
  "would",
  "you",
]);

const DEFAULT_REALTIME_VOICE_CONSULT_QUESTION_KEYS = ["question", "prompt", "query", "task"];
const DEFAULT_REALTIME_VOICE_SPEAKABLE_RESULT_KEYS = ["text", "result", "output", "error"];
const DEFAULT_REALTIME_VOICE_SPEAKABLE_RESULT_MAX_CHARS = 1_800;

export type RealtimeVoiceConsultQuestionMatchOptions = {
  /** Minimum overlap ratio against the smaller token set for fuzzy matches. */
  minTokenOverlapRatio?: number;
  /** Minimum number of non-stopword tokens that must overlap. */
  minTokenOverlapCount?: number;
};

export type RealtimeVoiceSpeakableToolResultOptions = {
  /** Candidate result keys to read from object-shaped tool output. */
  keys?: readonly string[];
  /** Maximum spoken result length before appending a truncation marker. */
  maxChars?: number;
  /** Whether a raw string result is allowed as speakable output. */
  stringResult?: boolean;
};

/** Read the consult question from a raw string or selected object keys. */
export function readRealtimeVoiceConsultQuestion(
  args: unknown,
  keys: readonly string[] = DEFAULT_REALTIME_VOICE_CONSULT_QUESTION_KEYS,
): string | undefined {
  if (typeof args === "string") {
    return normalizeOptionalString(args);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  return readTrimmedStringAlias(args as Record<string, unknown>, keys);
}

/** Normalize consult questions for stable matching across punctuation/casing. */
export function normalizeRealtimeVoiceConsultQuestion(
  value: string | undefined,
): string | undefined {
  return (
    value
      ?.toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim() || undefined
  );
}

/** Compare two consult questions with exact, containment, and token-overlap matching. */
export function matchRealtimeVoiceConsultQuestions(
  left: string | undefined,
  right: string | undefined,
  options: RealtimeVoiceConsultQuestionMatchOptions = {},
): boolean {
  const normalizedLeft = normalizeRealtimeVoiceConsultQuestion(left);
  const normalizedRight = normalizeRealtimeVoiceConsultQuestion(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  // Containment catches common provider rewrites such as adding "please" or
  // "can you" around the same short question.
  if (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }
  const leftTokens = realtimeVoiceConsultQuestionTokens(normalizedLeft);
  const rightTokens = realtimeVoiceConsultQuestionTokens(normalizedRight);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  const minTokenOverlapCount = options.minTokenOverlapCount ?? 2;
  if (overlap < minTokenOverlapCount) {
    return false;
  }
  const minTokenOverlapRatio = options.minTokenOverlapRatio ?? 0.6;
  return overlap / Math.min(leftTokens.size, rightTokens.size) >= minTokenOverlapRatio;
}

/** Extract a bounded speakable string from a tool result payload. */
export function readSpeakableRealtimeVoiceToolResult(
  result: unknown,
  options: RealtimeVoiceSpeakableToolResultOptions = {},
): string | undefined {
  const stringResult = options.stringResult ?? true;
  if (typeof result === "string") {
    return stringResult
      ? limitSpeakableRealtimeVoiceToolResult(result, options.maxChars)
      : undefined;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const keys = options.keys ?? DEFAULT_REALTIME_VOICE_SPEAKABLE_RESULT_KEYS;
  const value = readTrimmedStringAlias(record, keys);
  return value ? limitSpeakableRealtimeVoiceToolResult(value, options.maxChars) : undefined;
}

function realtimeVoiceConsultQuestionTokens(value: string): Set<string> {
  // Drop short/stopword tokens so overlap is based on the semantic parts of the
  // question instead of assistant boilerplate.
  return new Set(
    value
      .split(/[^\p{L}\p{N}]+/gu)
      .map((token) => token.trim())
      .filter(
        (token) => token.length >= 2 && !REALTIME_VOICE_CONSULT_QUESTION_STOPWORDS.has(token),
      ),
  );
}

function limitSpeakableRealtimeVoiceToolResult(
  value: string,
  maxChars = DEFAULT_REALTIME_VOICE_SPEAKABLE_RESULT_MAX_CHARS,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  // Reserve space for the marker so callers can keep audio replies under a
  // provider or UX limit without losing the truncation signal.
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 16)).trimEnd()} [truncated]`;
}
