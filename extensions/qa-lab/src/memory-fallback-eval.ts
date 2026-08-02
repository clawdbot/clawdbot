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
const EXPLICIT_MEMORY_AVAILABILITY =
  /\b(?:memory(?:\s+access)?|hidden(?:\s+(?:fact|information|value))?)\b[^.!?\n]{0,40}\b(?:is|are|remains?)\s+(?:available|accessible|enabled|working)\b/iu;

export function hasUnavailableMemoryBoundary(text: string): boolean {
  const trimmed = text.trim();
  if (
    !trimmed ||
    !MEMORY_BOUNDARY_SUBJECT.test(trimmed) ||
    EXPLICIT_MEMORY_AVAILABILITY.test(trimmed)
  ) {
    return false;
  }
  // Match the boundary's concepts, not provider-specific prose, while rejecting
  // generic refusals that are unrelated to the memory fact in the same sentence.
  return trimmed
    .split(/[.!?\n]+/u)
    .some(
      (sentence) =>
        MEMORY_BOUNDARY_SUBJECT.test(sentence) &&
        (UNAVAILABLE_STATE.test(sentence) ||
          (LIMIT_MARKER.test(sentence) && BOUNDARY_ACTION.test(sentence)) ||
          (LIMITED_CONFIRMATION.test(sentence) && EXISTENCE_CLAIM.test(sentence))),
    );
}
