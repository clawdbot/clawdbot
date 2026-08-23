import { normalizeTextForComparison } from "../../embedded-agent-helpers.js";

const MUTATING_FAILURE_ACTION_PATTERN =
  "(?:write|edit|update|save|create|delete|remove|modify|change|apply|patch|move|rename|send|reply|message|run|execute|execution|command|script|shell|bash|exec|tool|action|operation)";
const MUTATING_FAILURE_INABILITY_PATTERN = new RegExp(
  `\\b(?:couldn't|could not|can't|cannot|unable to|am unable to|wasn't able to|was not able to|were unable to)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const MUTATING_FAILURE_ACTION_THEN_FAILURE_PATTERN = new RegExp(
  `\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b.{0,100}\\b(?:failed|failure|errored)\\b`,
  "u",
);
const MUTATING_FAILURE_FAILURE_THEN_ACTION_PATTERN = new RegExp(
  `\\b(?:failed|failure)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const MUTATING_FAILURE_ERROR_WHILE_ACTION_PATTERN = new RegExp(
  `\\b(?:hit|encountered|ran into)\\b.{0,60}\\berror\\b.{0,100}\\b(?:while|trying to|when)\\b.{0,100}\\b${MUTATING_FAILURE_ACTION_PATTERN}\\b`,
  "u",
);
const DID_NOT_FAIL_PATTERN = /\b(?:did not|didn't)\s+fail\b/u;
const NEGATED_FAILURE_PATTERN = /\b(?:no|not|without)\s+(?:failures?|errors?)\b/u;

/** Detect a user-visible acknowledgement that a mutating action did not complete. */
export function hasExplicitMutatingToolFailureAcknowledgement(text: string): boolean {
  const normalizedText = normalizeTextForComparison(text);
  if (!normalizedText || DID_NOT_FAIL_PATTERN.test(normalizedText)) {
    return false;
  }
  if (MUTATING_FAILURE_INABILITY_PATTERN.test(normalizedText)) {
    return true;
  }
  if (NEGATED_FAILURE_PATTERN.test(normalizedText)) {
    return false;
  }
  return (
    MUTATING_FAILURE_ACTION_THEN_FAILURE_PATTERN.test(normalizedText) ||
    MUTATING_FAILURE_FAILURE_THEN_ACTION_PATTERN.test(normalizedText) ||
    MUTATING_FAILURE_ERROR_WHILE_ACTION_PATTERN.test(normalizedText)
  );
}
