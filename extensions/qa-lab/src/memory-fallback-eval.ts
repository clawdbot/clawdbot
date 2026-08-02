// Qa Lab plugin module evaluates memory-unavailable fallback replies.
const MEMORY_BOUNDARY_SUBJECT =
  /\b(?:memory|hidden(?:\s+(?:fact|information|value))?|memory-backed\s+(?:notes?|information))\b/iu;
const UNAVAILABLE_STATE = /\b(?:unavailable|inaccessible|unknown|unverified|withheld)\b/iu;
const LIMIT_MARKER =
  /\b(?:cannot|can['’]t|could not|couldn['’]t|unable|not able|do not|don['’]t|will not|won['’]t|should not|shouldn['’]t|without|lack(?:ing)?|no access)\b/iu;
const BOUNDARY_ACTION =
  /\b(?:access|confirm|verify|retrieve|read|see|know|reveal|disclose|guess|provide|determine|infer|speculate)\b/iu;
const LIMITED_CONFIRMATION =
  /\b(?:only|just)\b[^.!?]{0,80}\b(?:confirm|verify|say|acknowledge)\b|\b(?:confirm|verify|say|acknowledge)\b[^.!?]{0,80}\b(?:only|just)\b/iu;
const EXISTENCE_CLAIM = /\b(?:exists?|present)\b/iu;
const AFFIRMATIVE_MEMORY_STATE =
  /\b(?:memory(?:\s+access)?|hidden(?:\s+(?:fact|information|value))?)\b[^.!?\n]{0,40}(?:\b(?:is|are|remains?)\s+(?:available|accessible|enabled|known|working)\b|\bcan\s+be\s+(?:accessed|read|retrieved)\b)/iu;
const AFFIRMATIVE_MEMORY_POSSESSION =
  /\b(?:i|we)\s+(?:do\s+)?(?:have|possess|retain)\s+(?:(?:current|direct|full|limited|some)\s+)?(?:access\s+to\s+)?(?:it\b|that\b|this\b|(?:the\s+)?(?:memory(?:-backed\s+(?:notes?|information))?|hidden(?:\s+(?:fact|information|value))?)\b)/iu;
const AFFIRMATIVE_RESPONDER_KNOWLEDGE =
  /\b(?:i|we)\s+(?:(?:can|do|still)\s+|am\s+able\s+to\s+)?(?:access|know|read|remember|retrieve)\b/iu;
const RESPONDER_ACTOR = /\b(?:i|me|my|mine|we|us|our|ours)\b/iu;
const RESPONDER_UNAVAILABLE_SCOPE =
  /\b(?:unavailable|inaccessible|unknown|unverified|withheld)\b[^.!?\n]{0,40}(?:(?:to|for)\s+(?:me|us)\b|(?:from|in)\s+(?:my|our)\b)|\b(?:my|our)\b[^.!?\n]{0,40}\b(?:unavailable|inaccessible|unknown|unverified|withheld)\b/iu;

export function hasUnavailableMemoryBoundary(text: string): boolean {
  const trimmed = text.trim();
  if (
    !trimmed ||
    !MEMORY_BOUNDARY_SUBJECT.test(trimmed) ||
    AFFIRMATIVE_MEMORY_STATE.test(trimmed) ||
    AFFIRMATIVE_MEMORY_POSSESSION.test(trimmed) ||
    AFFIRMATIVE_RESPONDER_KNOWLEDGE.test(trimmed)
  ) {
    return false;
  }
  // The boundary must describe this responder's limitation. Recipient-only
  // limits and contradictory first-person access or knowledge stay failures.
  return trimmed
    .split(/[.!?\n]+/u)
    .some(
      (sentence) =>
        MEMORY_BOUNDARY_SUBJECT.test(sentence) &&
        ((UNAVAILABLE_STATE.test(sentence) && RESPONDER_UNAVAILABLE_SCOPE.test(sentence)) ||
          (LIMIT_MARKER.test(sentence) &&
            BOUNDARY_ACTION.test(sentence) &&
            RESPONDER_ACTOR.test(sentence)) ||
          (LIMITED_CONFIRMATION.test(sentence) &&
            EXISTENCE_CLAIM.test(sentence) &&
            RESPONDER_ACTOR.test(sentence))),
    );
}
