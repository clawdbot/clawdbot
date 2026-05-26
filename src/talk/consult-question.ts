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
  minTokenOverlapRatio?: number;
  minTokenOverlapCount?: number;
};

export type RealtimeVoiceSpeakableToolResultOptions = {
  keys?: readonly string[];
  maxChars?: number;
  stringResult?: boolean;
};

export function readRealtimeVoiceConsultQuestion(
  args: unknown,
  keys: readonly string[] = DEFAULT_REALTIME_VOICE_CONSULT_QUESTION_KEYS,
): string | undefined {
  if (typeof args === "string") {
    return args.trim() || undefined;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

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
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return limitSpeakableRealtimeVoiceToolResult(value, options.maxChars);
    }
  }
  return undefined;
}

function realtimeVoiceConsultQuestionTokens(value: string): Set<string> {
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
  return `${trimmed.slice(0, Math.max(0, maxChars - 16)).trimEnd()} [truncated]`;
}
