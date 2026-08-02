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

export function hasUnavailableMemoryBoundary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !MEMORY_BOUNDARY_SUBJECT.test(trimmed)) {
    return false;
  }
  // Match the boundary's concepts, not provider-specific prose, while rejecting
  // generic refusals that do not acknowledge the unavailable memory fact.
  return (
    UNAVAILABLE_STATE.test(trimmed) ||
    (LIMIT_MARKER.test(trimmed) && BOUNDARY_ACTION.test(trimmed)) ||
    (LIMITED_CONFIRMATION.test(trimmed) && EXISTENCE_CLAIM.test(trimmed))
  );
}
