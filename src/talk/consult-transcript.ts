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

// A bounded grammar for ordinary closing components, not general intent detection.
const REALTIME_VOICE_CLOSING_REMAINDER = new RegExp(
  String.raw`^(?:(?:${[
    "ok(?:ay)?|all right|alright|well|so|and",
    "thanks(?: a lot| so much)?|thank you(?: very much)?|take care",
    "have a (?:good|nice|great) (?:day|night|evening|weekend)",
    "guys|everyone|everybody|all|folks|you all",
    "for now|now|later|soon|tomorrow|tonight|next (?:time|week|month|year|weekend)",
    "(?:on |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
    String.raw`in (?:a|a few|few|one|two|three|four|five|six|seven|eight|nine|ten|\d+) (?:second|minute|moment)s?`,
    "in a bit|in the (?:morning|afternoon|evening)",
  ].join("|")})\b|[.! ,;:—–-])*$`,
);

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
  // Once closing phrases are removed, only closing components and separators may
  // remain. Additional prose, questions, and code must still reach the agent.
  const remainder = normalized.replace(
    /\b(?:(?:i['’]?ll|i will) be (?:right )?back|see you|bye(?:[- ]bye)?|good[- ]?bye)\b/g,
    "",
  );
  if (remainder !== normalized && REALTIME_VOICE_CLOSING_REMAINDER.test(remainder)) {
    return "non-actionable-closing";
  }
  return undefined;
}
