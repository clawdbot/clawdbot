import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTextForComparison } from "../../embedded-agent-helpers.js";

const MUTATING_FAILURE_WORD_PATTERN = "(?:failed|failure|errored)";
const MUTATING_FAILURE_ACTION_DETAIL_PATTERN =
  "(?:\\s+(?:tool|operation|action|attempt|step|call|request))?";
const DID_NOT_FAIL_PATTERN = /\b(?:did not|didn't)\s+fail\b/u;
const NEGATED_FAILURE_PATTERN = /\b(?:no|not|without)\s+(?:failures?|errors?)\b/u;

function escapeRegexPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNormalizedToolNameParts(toolName: string): string[] {
  return (normalizeOptionalLowercaseString(toolName) ?? "").split(/[_\s.-]+/u).filter(Boolean);
}

function getMutatingFailureActionPattern(toolName: string, acknowledgementAction?: string): string {
  const normalizedAction = normalizeOptionalLowercaseString(acknowledgementAction) ?? "";
  if (normalizedAction === "write") {
    return "(?:write|writing|wrote|save|saved)";
  }
  if (normalizedAction === "edit" || normalizedAction === "patch") {
    return "(?:edit|edited|modify|modified|change|changed|apply|applied|patch|patched)";
  }
  if (normalizedAction === "send") {
    return "(?:send|sent|reply|replied|message|messaged|post|posted|dm)";
  }
  if (normalizedAction === "delete") {
    return "(?:delete|deleted|remove|removed)";
  }
  if (normalizedAction === "create") {
    return "(?:create|created|add|added|make|made)";
  }
  if (normalizedAction === "update") {
    return "(?:update|updated)";
  }
  if (normalizedAction === "spawn") {
    return "(?:spawn|spawned|start|started)";
  }
  if (normalizedAction.includes("click")) {
    return "(?:click|clicked|select|selected|press|pressed)";
  }
  if (normalizedAction === "type") {
    return "(?:type|typed|enter|entered|input|insert|inserted)";
  }
  if (normalizedAction.includes("key")) {
    return "(?:key|press|pressed|type|typed)";
  }
  const normalizedToolName = normalizeOptionalLowercaseString(toolName) ?? "";
  if (!normalizedAction && normalizedToolName === "message") {
    return "(?!)";
  }
  const toolNameParts = getNormalizedToolNameParts(toolName);
  if (normalizedToolName === "write" || toolNameParts.includes("write")) {
    return "(?:write|writing|wrote|save|saved)";
  }
  if (
    normalizedToolName === "edit" ||
    normalizedToolName === "apply_patch" ||
    toolNameParts.includes("edit") ||
    toolNameParts.includes("patch")
  ) {
    return "(?:edit|edited|modify|modified|change|changed|apply|applied|patch|patched)";
  }
  if (
    normalizedToolName === "message" ||
    normalizedToolName === "sessions_send" ||
    normalizedToolName === "conversations_send" ||
    normalizedToolName === "conversations_turn" ||
    toolNameParts.includes("message") ||
    toolNameParts.includes("send")
  ) {
    return "(?:send|sent|reply|replied|message|messaged|post|posted|dm)";
  }
  const words = (normalizedAction || normalizedToolName)
    .split(/[_\s.-]+/u)
    .filter(Boolean)
    .map(escapeRegexPattern);
  return words.length > 0 ? `(?:${words.join("[_\\s.-]+")})` : "(?!)";
}

/** Detect a user-visible acknowledgement that a mutating action did not complete. */
export function hasExplicitMutatingToolFailureAcknowledgement(
  text: string,
  toolName: string,
  acknowledgementAction?: string,
): boolean {
  const normalizedText = normalizeTextForComparison(text);
  if (!normalizedText || DID_NOT_FAIL_PATTERN.test(normalizedText)) {
    return false;
  }
  const actionPattern = getMutatingFailureActionPattern(toolName, acknowledgementAction);
  const normalizedAction = normalizeOptionalLowercaseString(acknowledgementAction) ?? "";
  if (
    normalizedAction &&
    normalizedAction !== "send" &&
    /\bmessage\s+could\s+not\s+be\s+sent\b/u.test(normalizedText)
  ) {
    return false;
  }
  const inabilityPattern = new RegExp(
    `(?:\\b(?:couldn't|could not|can't|cannot|unable to|am unable to|wasn't able to|was not able to|were unable to)\\s+\\b${actionPattern}\\b|\\b${actionPattern}\\b\\s+(?:couldn't|could not|can't|cannot)\\s+be\\s+\\b${actionPattern}\\b)`,
    "u",
  );
  if (inabilityPattern.test(normalizedText)) {
    return true;
  }
  if (NEGATED_FAILURE_PATTERN.test(normalizedText)) {
    return false;
  }
  const acknowledgementPattern = new RegExp(
    `(?:\\b${actionPattern}\\b${MUTATING_FAILURE_ACTION_DETAIL_PATTERN}\\s+\\b${MUTATING_FAILURE_WORD_PATTERN}\\b|\\b${MUTATING_FAILURE_WORD_PATTERN}\\b\\s+(?:to|while|when|during|on)\\s+\\b${actionPattern}\\b|\\b(?:hit|encountered|ran into)\\b.{0,60}\\berror\\b.{0,100}\\b(?:while|trying to|when)\\s+\\b${actionPattern}\\b)`,
    "u",
  );
  return acknowledgementPattern.test(normalizedText);
}
