/**
 * Transcript guardrails for realtime voice agent consults.
 *
 * ASR often emits partial fragments or polite closings that should not trigger
 * an OpenClaw consult. This classifier names those skip reasons for callers.
 */
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

/** Reason a transcript should be ignored before creating a consult request. */
export type SkippableRealtimeVoiceConsultTranscriptReason =
  | "empty"
  | "incomplete-transcript"
  | "trailing-fragment"
  | "non-actionable-closing";

/** Classify transcript text that is empty, incomplete, fragmented, or non-actionable. */
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
  // A trailing connector usually means ASR has not emitted the object yet:
  // "tell me about", "ship it so", "check the".
  if (lastWord && REALTIME_VOICE_CONSULT_TRAILING_FRAGMENT_WORDS.has(lastWord)) {
    return "trailing-fragment";
  }
  // Closings are ignored unless they are framed as questions, because they are
  // common conversational exits rather than work requests.
  if (
    !normalized.includes("?") &&
    (/^(i'?ll|i will) be (right )?back\b/.test(normalized) ||
      /\b(see you|bye(?:-bye)?|goodbye)\b/.test(normalized))
  ) {
    return "non-actionable-closing";
  }
  return undefined;
}
