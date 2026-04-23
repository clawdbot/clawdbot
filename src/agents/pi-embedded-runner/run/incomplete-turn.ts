import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { EmbeddedPiExecutionContract } from "../../../config/types.agent-defaults.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import { isStrictAgenticSupportedProviderModel } from "../../execution-contract.js";
import { isLikelyMutatingToolName } from "../../tool-mutation.js";
import { assessLastAssistantMessage } from "../thinking.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ReplayMetadataAttempt = Pick<
  EmbeddedRunAttemptResult,
  "toolMetas" | "didSendViaMessagingTool" | "successfulCronAdds"
>;

type IncompleteTurnAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCall"
  | "currentAttemptAssistant"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "replayMetadata"
  | "promptErrorSource"
  | "timedOutDuringCompaction"
>;

type PlanningOnlyAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCall"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "itemLifecycle"
  | "replayMetadata"
  | "toolMetas"
>;

type RunLivenessAttempt = Pick<
  EmbeddedRunAttemptResult,
  "lastAssistant" | "promptErrorSource" | "replayMetadata" | "timedOutDuringCompaction"
>;

export function isIncompleteTerminalAssistantTurn(params: {
  hasAssistantVisibleText: boolean;
  lastAssistant?: { stopReason?: string } | null;
}): boolean {
  return !params.hasAssistantVisibleText && params.lastAssistant?.stopReason === "toolUse";
}

const PLANNING_ONLY_PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;
const PLANNING_ONLY_COMPLETION_RE =
  /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;
const PLANNING_ONLY_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;
const PLANNING_ONLY_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;
const PLANNING_ONLY_MAX_VISIBLE_TEXT = 700;
const PLANNING_ONLY_ACTION_VERB_RE =
  /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|prepare|capture|take|refactor|restart|deploy|ship)\b/i;
const SINGLE_ACTION_EXPLICIT_CONTINUATION_RE =
  /\b(?:going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|then[, ]+i(?:'ll| will)|i can do that next|let me (?!know\b)\w+(?:\s+\w+){0,3}\s+(?:next|then|first)\b)/i;
const SINGLE_ACTION_MULTI_STEP_PROMISE_RE =
  /\bi(?:'ll| will)\b(?=[^.!?]{0,160}\b(?:next|then|after(?:wards)?|once)\b)/i;
const SINGLE_ACTION_RESULT_STYLE_RE =
  /\b(?:i(?:'ll| will)\s+(?:summarize|explain|share|show|report|describe|clarify|answer|recap)(?:\s+\w+){0,4}\s*:|(?:here(?:'s| is)|summary|result|answer|findings?|root cause)\s*:)/i;
const SINGLE_ACTION_RETRY_SAFE_TOOL_NAMES = new Set([
  "read",
  "search",
  "find",
  "grep",
  "glob",
  "ls",
]);
const DEFAULT_PLANNING_ONLY_RETRY_LIMIT = 1;
const STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT = 2;
// Allow one immediate continuation plus one follow-up continuation before
// surfacing the existing incomplete-turn error path.
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1;
const ACK_EXECUTION_NORMALIZED_SET = new Set([
  "ok",
  "okay",
  "ok do it",
  "okay do it",
  "do it",
  "go ahead",
  "please do",
  "sounds good",
  "sounds good do it",
  "ship it",
  "fix it",
  "make it so",
  "yes do it",
  "yep do it",
  "تمام",
  "حسنا",
  "حسنًا",
  "امض قدما",
  "نفذها",
  "mach es",
  "leg los",
  "los geht s",
  "weiter",
  "やって",
  "進めて",
  "そのまま進めて",
  "allez y",
  "vas y",
  "fais le",
  "continue",
  "hazlo",
  "adelante",
  "sigue",
  "faz isso",
  "vai em frente",
  "pode fazer",
  "해줘",
  "진행해",
  "계속해",
]);
const ACTIONABLE_PROMPT_DIRECTIVE_RE =
  /^\s*(?:please\s+)?(?:check|look(?:\s+into|\s+at)?|read|write|edit|update|fix|investigate|debug|run|search|find|implement|add|remove|refactor|explain|summari(?:s|z)e|analy(?:s|z)e|review|tell|show|make|restart|deploy|prepare)\b/i;
const ACTIONABLE_PROMPT_REQUEST_RE =
  /\b(?:can|could|would|will)\s+you\b|\b(?:please|pls)\b|\b(?:help|explain|summari(?:s|z)e|analy(?:s|z)e|review|investigate|debug|fix|check|look(?:\s+into|\s+at)?|read|write|edit|update|run|search|find|implement|add|remove|refactor|show|tell me|walk me through)\b/i;

export const PLANNING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";
export const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
export const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
export const ACK_EXECUTION_FAST_PATH_INSTRUCTION =
  "The latest user message is a short approval to proceed. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";
export const STRICT_AGENTIC_BLOCKED_TEXT =
  "Agent stopped after repeated plan-only turns without taking a concrete action. No concrete tool action or external side effect advanced the task.";

export type PlanningOnlyPlanDetails = {
  explanation: string;
  steps: string[];
};

export function buildAttemptReplayMetadata(
  params: ReplayMetadataAttempt,
): EmbeddedRunAttemptResult["replayMetadata"] {
  const hadMutatingTools = params.toolMetas.some((t) => isLikelyMutatingToolName(t.toolName));
  const hadPotentialSideEffects =
    hadMutatingTools || params.didSendViaMessagingTool || (params.successfulCronAdds ?? 0) > 0;
  return {
    hadPotentialSideEffects,
    replaySafe: !hadPotentialSideEffects,
  };
}

export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (
    params.payloadCount !== 0 ||
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return null;
  }

  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  // If the assistant already delivered user-visible content via a messaging
  // tool during this turn and ended cleanly (stopReason=stop), do not surface
  // an incomplete-turn warning. The user has received the reply; a follow-up
  // "couldn't generate a response" bubble is a false positive. Provider-side
  // failures (stopReason=error, toolUse interruption) still fall through to
  // the normal incomplete-turn paths below; tool-error cases are already
  // handled by the lastToolError early return above.
  if (params.attempt.didSendViaMessagingTool && stopReason === "stop") {
    return null;
  }
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText: params.payloadCount > 0,
    lastAssistant: params.attempt.lastAssistant,
  });
  const reasoningOnlyAssistant = isReasoningOnlyAssistantTurn(
    params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant,
  );
  const emptyResponseAssistant = isEmptyResponseAssistantTurn({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
  if (
    !incompleteTerminalAssistant &&
    !reasoningOnlyAssistant &&
    !emptyResponseAssistant &&
    stopReason !== "error"
  ) {
    return null;
  }

  return params.attempt.replayMetadata.hadPotentialSideEffects
    ? "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying."
    : "⚠️ Agent couldn't generate a response. Please try again.";
}

function hasOnlySilentAssistantReply(assistantTexts: readonly string[]): boolean {
  const nonEmptyTexts = assistantTexts.filter((text) => text.trim().length > 0);
  return (
    nonEmptyTexts.length > 0 &&
    nonEmptyTexts.every((text) => isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN))
  );
}

export function resolveReplayInvalidFlag(params: {
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): boolean {
  return (
    !params.attempt.replayMetadata.replaySafe ||
    params.attempt.promptErrorSource === "compaction" ||
    params.attempt.timedOutDuringCompaction ||
    Boolean(params.incompleteTurnText)
  );
}

export function resolveRunLivenessState(params: {
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): EmbeddedRunLivenessState {
  if (params.incompleteTurnText) {
    return "abandoned";
  }
  if (
    params.attempt.promptErrorSource === "compaction" ||
    params.attempt.timedOutDuringCompaction
  ) {
    return "paused";
  }
  if ((params.aborted || params.timedOut) && params.payloadCount === 0) {
    return "blocked";
  }
  if (params.attempt.lastAssistant?.stopReason === "error") {
    return "blocked";
  }
  return "working";
}

export function isReasoningOnlyAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-text";
}

function isEmptyResponseAssistantTurn(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "lastAssistant"
  >;
}): boolean {
  if (params.payloadCount !== 0) {
    return false;
  }
  if (params.attempt.assistantTexts.join("\n\n").trim().length > 0) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (!assistant) {
    return true;
  }
  if (assistant.stopReason === "error") {
    return false;
  }
  if (
    isIncompleteTerminalAssistantTurn({
      hasAssistantVisibleText: false,
      lastAssistant: assistant,
    }) ||
    isReasoningOnlyAssistantTurn(assistant)
  ) {
    return false;
  }
  return true;
}

function shouldSkipPlanningOnlyRetry(params: {
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  return Boolean(
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    params.attempt.replayMetadata.hadPotentialSideEffects,
  );
}

export function resolveReasoningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  executionContract?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipPlanningOnlyRetry(params)) {
    return null;
  }

  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (params.attempt.assistantTexts.join("\n\n").trim().length > 0) {
    return null;
  }
  if (assistant?.stopReason === "error") {
    return null;
  }
  if (!isReasoningOnlyAssistantTurn(assistant)) {
    return null;
  }

  return REASONING_ONLY_RETRY_INSTRUCTION;
}

export function resolveEmptyResponseRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  executionContract?: string;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipPlanningOnlyRetry(params)) {
    return null;
  }

  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }

  if (
    !isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    })
  ) {
    return null;
  }

  return EMPTY_RESPONSE_RETRY_INSTRUCTION;
}

function shouldApplyPlanningOnlyRetryGuard(params: {
  provider?: string;
  modelId?: string;
  executionContract?: string;
}): boolean {
  if (params.executionContract === "strict-agentic") {
    return true;
  }
  return isStrictAgenticSupportedProviderModel({
    provider: params.provider,
    modelId: params.modelId,
  });
}

function normalizeAckPrompt(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeLowercaseStringOrEmpty(normalized);
}

export function isLikelyExecutionAckPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes("\n") || trimmed.includes("?")) {
    return false;
  }
  return ACK_EXECUTION_NORMALIZED_SET.has(normalizeAckPrompt(trimmed));
}

function isLikelyActionableUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isLikelyExecutionAckPrompt(trimmed) || trimmed.includes("?")) {
    return true;
  }
  return ACTIONABLE_PROMPT_DIRECTIVE_RE.test(trimmed) || ACTIONABLE_PROMPT_REQUEST_RE.test(trimmed);
}

export function resolveAckExecutionFastPathInstruction(params: {
  provider?: string;
  modelId?: string;
  prompt: string;
}): string | null {
  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
    }) ||
    !isLikelyExecutionAckPrompt(params.prompt)
  ) {
    return null;
  }
  return ACK_EXECUTION_FAST_PATH_INSTRUCTION;
}

function extractPlanningOnlySteps(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletLines = lines
    .map((line) => line.replace(/^[-*•]\s+|^\d+[.)]\s+/u, "").trim())
    .filter(Boolean);
  if (bulletLines.length >= 2) {
    return bulletLines.slice(0, 4);
  }
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function hasStructuredPlanningOnlyFormat(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const bulletLineCount = lines.filter((line) => PLANNING_ONLY_BULLET_RE.test(line)).length;
  const hasPlanningCueLine = lines.some((line) => PLANNING_ONLY_PROMISE_RE.test(line));
  const hasPlanningHeading = PLANNING_ONLY_HEADING_RE.test(lines[0] ?? "");
  return (hasPlanningHeading && hasPlanningCueLine) || (bulletLineCount >= 2 && hasPlanningCueLine);
}

export function extractPlanningOnlyPlanDetails(text: string): PlanningOnlyPlanDetails | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const steps = extractPlanningOnlySteps(trimmed);
  return {
    explanation: trimmed,
    steps,
  };
}

function countPlanOnlyToolMetas(toolMetas: PlanningOnlyAttempt["toolMetas"]): number {
  return toolMetas.filter((entry) => entry.toolName === "update_plan").length;
}

function countNonPlanToolCalls(toolMetas: PlanningOnlyAttempt["toolMetas"]): number {
  return toolMetas.filter((entry) => entry.toolName !== "update_plan").length;
}

function hasNonPlanToolActivity(toolMetas: PlanningOnlyAttempt["toolMetas"]): boolean {
  return toolMetas.some((entry) => entry.toolName !== "update_plan");
}

function hasSingleRetrySafeNonPlanTool(toolMetas: PlanningOnlyAttempt["toolMetas"]): boolean {
  const nonPlanToolNames = toolMetas
    .map((entry) => normalizeLowercaseStringOrEmpty(entry.toolName))
    .filter((toolName) => toolName && toolName !== "update_plan");
  return (
    nonPlanToolNames.length === 1 &&
    SINGLE_ACTION_RETRY_SAFE_TOOL_NAMES.has(nonPlanToolNames[0] ?? "")
  );
}

/**
 * Treat a turn with exactly one non-plan tool call plus visible "I'll do X
 * next" prose as effectively planning-only from the user's perspective. This
 * closes the one-action-then-narrative loophole without changing the 2+ tool
 * call path, which still counts as real multi-step progress.
 */
function isSingleActionThenNarrativePattern(params: {
  toolMetas: PlanningOnlyAttempt["toolMetas"];
  assistantTexts: readonly string[];
}): boolean {
  const nonPlanCount = countNonPlanToolCalls(params.toolMetas);
  if (nonPlanCount !== 1) {
    return false;
  }
  const text = params.assistantTexts.join("\n\n").trim();
  if (!text || text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT) {
    return false;
  }
  if (SINGLE_ACTION_RESULT_STYLE_RE.test(text)) {
    return false;
  }
  return (
    SINGLE_ACTION_EXPLICIT_CONTINUATION_RE.test(text) ||
    SINGLE_ACTION_MULTI_STEP_PROMISE_RE.test(text)
  );
}

export function resolvePlanningOnlyRetryLimit(
  executionContract?: EmbeddedPiExecutionContract,
): number {
  return executionContract === "strict-agentic"
    ? STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT
    : DEFAULT_PLANNING_ONLY_RETRY_LIMIT;
}

export function resolvePlanningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  executionContract?: string;
  prompt?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: PlanningOnlyAttempt;
}): string | null {
  const planOnlyToolMetaCount = countPlanOnlyToolMetas(params.attempt.toolMetas);
  const singleActionNarrative = isSingleActionThenNarrativePattern({
    toolMetas: params.attempt.toolMetas,
    assistantTexts: params.attempt.assistantTexts,
  });
  const allowSingleActionRetryBypass =
    singleActionNarrative && hasSingleRetrySafeNonPlanTool(params.attempt.toolMetas);
  if (
    !shouldApplyPlanningOnlyRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      executionContract: params.executionContract,
    }) ||
    (typeof params.prompt === "string" && !isLikelyActionableUserPrompt(params.prompt)) ||
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCall ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.didSendViaMessagingTool ||
    params.attempt.lastToolError ||
    (hasNonPlanToolActivity(params.attempt.toolMetas) && !allowSingleActionRetryBypass) ||
    (params.attempt.itemLifecycle.startedCount > planOnlyToolMetaCount &&
      !allowSingleActionRetryBypass) ||
    params.attempt.replayMetadata.hadPotentialSideEffects
  ) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason && stopReason !== "stop") {
    return null;
  }

  const text = params.attempt.assistantTexts.join("\n\n").trim();
  if (!text || text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT || text.includes("```")) {
    return null;
  }
  const hasStructuredPlanningFormat = hasStructuredPlanningOnlyFormat(text);
  if (!PLANNING_ONLY_PROMISE_RE.test(text) && !hasStructuredPlanningFormat) {
    return null;
  }
  if (
    !hasStructuredPlanningFormat &&
    !singleActionNarrative &&
    !PLANNING_ONLY_ACTION_VERB_RE.test(text)
  ) {
    return null;
  }
  if (PLANNING_ONLY_COMPLETION_RE.test(text)) {
    return null;
  }
  return PLANNING_ONLY_RETRY_INSTRUCTION;
}
