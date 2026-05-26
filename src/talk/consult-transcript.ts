const REALTIME_VOICE_CONSULT_TRAILING_FRAGMENT_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "as",
  "at",
  "because",
  "but",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "then",
  "to",
  "with",
]);

export type SkippableRealtimeVoiceConsultTranscriptReason =
  | "empty"
  | "incomplete-transcript"
  | "trailing-fragment"
  | "non-actionable-closing";

export function classifySkippableRealtimeVoiceConsultTranscript(
  text: string,
): SkippableRealtimeVoiceConsultTranscriptReason | undefined {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return "empty";
  }
  if (/(\.\.\.|…)\s*$/.test(normalized)) {
    return "incomplete-transcript";
  }
  const lastWord = normalized.match(/[a-z']+$/)?.[0]?.replace(/^'+|'+$/g, "");
  if (lastWord && REALTIME_VOICE_CONSULT_TRAILING_FRAGMENT_WORDS.has(lastWord)) {
    return "trailing-fragment";
  }
  if (
    !normalized.includes("?") &&
    (/^(i'?ll|i will) be (right )?back\b/.test(normalized) ||
      /\b(see you|bye(?:-bye)?|goodbye)\b/.test(normalized))
  ) {
    return "non-actionable-closing";
  }
  return undefined;
}
