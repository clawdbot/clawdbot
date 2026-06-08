/**
 * Classifies incomplete terminal assistant turns and retry instructions.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../../../auto-reply/tokens.js";
import type { EmbeddedAgentExecutionContract } from "../../../config/types.agent-defaults.js";
import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { collectTextContentBlocks } from "../../content-blocks.js";
import {
  isStrictAgenticSupportedProviderModel,
  stripProviderPrefix,
} from "../../execution-contract.js";
import type { AgentMessage } from "../../runtime/index.js";
import { isLikelyMutatingToolName } from "../../tool-mutation.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
} from "../delivery-evidence.js";
import { isZeroUsageEmptyStopAssistantTurn } from "../empty-assistant-turn.js";
import { assessLastAssistantMessage } from "../thinking.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ReplayMetadataAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "toolMetas"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "successfulCronAdds"
> &
  Partial<Pick<EmbeddedRunAttemptResult, "messagingToolSentTargets" | "acceptedSessionSpawns">>;

type IncompleteTurnAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCalls"
  | "currentAttemptAssistant"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "lastToolError"
  | "lastAssistant"
  | "itemLifecycle"
  | "replayMetadata"
  | "promptErrorSource"
  | "timedOutDuringCompaction"
  | "toolMetas"
> &
  Partial<Pick<EmbeddedRunAttemptResult, "acceptedSessionSpawns">>;

type PlanningOnlyAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCalls"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "didSendViaMessagingTool"
  | "lastToolError"
  | "lastAssistant"
  | "itemLifecycle"
  | "replayMetadata"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "toolMetas"
>;

function hasPositiveOutputTokenUsage(message: AgentMessage | null): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return false;
  }
  const output = asFiniteNumber((usage as { output?: unknown }).output);
  return output !== undefined && output > 0;
}

type SilentToolResultAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "clientToolCalls"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "lastToolError"
  | "messagesSnapshot"
  | "toolMetas"
>;

type RunLivenessAttempt = Pick<
  EmbeddedRunAttemptResult,
  "lastAssistant" | "promptErrorSource" | "replayMetadata" | "timedOutDuringCompaction"
>;

const REPLAY_UNSAFE_FALLBACK_METADATA: EmbeddedRunAttemptResult["replayMetadata"] = {
  hadPotentialSideEffects: true,
  replaySafe: false,
};

export function isIncompleteTerminalAssistantTurn(params: {
  hasAssistantVisibleText: boolean;
  lastAssistant?: { stopReason?: string } | null;
}): boolean {
  // A tool-use stop reason means the model issued a tool call and expected
  // to continue after tool results. If the session ended before the
  // post-tool assistant message arrived, the turn is incomplete regardless
  // of whether pre-tool text exists — that text is preliminary analysis,
  // not the final answer. (#76477)
  return params.lastAssistant?.stopReason === "toolUse";
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
const GEMINI_INCOMPLETE_TURN_PROVIDER_IDS = new Set([
  "google",
  "google-vertex",
  "google-antigravity",
  "google-gemini-cli",
]);
const GEMINI_INCOMPLETE_TURN_MODEL_ID_PATTERN = /^gemini(?:[.-]|$)/;
// Ollama native `/api/chat` can finish with only thinking/internal blocks when
// constrained, but it should not inherit the stricter planning-only/ack prompts.
const OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN = /^ollama(?:-|$)/;
// Model APIs eligible for the non-visible turn retry guard.  OpenAI Responses
// family can produce reasoning-only turns where usage.output > 0 but no visible
// text is emitted; without the guard these pass through as successful. (#85364)
const RETRY_GUARD_MODEL_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "bedrock-converse-stream",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
  "openclaw-openai-responses-transport",
  "openclaw-azure-openai-responses-transport",
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

/**
 * Marks whether retrying the attempt can safely replay the prompt. Mutating
 * tools, async work, committed delivery, spawned sessions, and cron writes all
 * count as side effects that make blind replay unsafe.
 */
export function buildAttemptReplayMetadata(
  params: ReplayMetadataAttempt,
): EmbeddedRunAttemptResult["replayMetadata"] {
  const hadMutatingTools = params.toolMetas.some((t) => isLikelyMutatingToolName(t.toolName));
  const hadAsyncStartedTool = params.toolMetas.some((t) => t.asyncStarted === true);
  const hadPotentialSideEffects =
    hadMutatingTools ||
    hadAsyncStartedTool ||
    hasMessagingToolDeliveryEvidence(params) ||
    hasAcceptedSessionSpawn(params.acceptedSessionSpawns) ||
    (params.successfulCronAdds ?? 0) > 0;
  return {
    hadPotentialSideEffects,
    replaySafe: !hadPotentialSideEffects,
  };
}

/** Falls back to replay-unsafe metadata when older attempt records lack replay details. */
export function resolveAttemptReplayMetadata(attempt: {
  replayMetadata?: EmbeddedRunAttemptResult["replayMetadata"] | null;
}): EmbeddedRunAttemptResult["replayMetadata"] {
  return attempt.replayMetadata ?? REPLAY_UNSAFE_FALLBACK_METADATA;
}

/**
 * Builds the user-visible incomplete-turn warning when a terminal attempt did
 * not produce a safe final assistant response and no committed delivery/progress
 * already completed the task.
 */
export function resolveIncompleteTurnPayloadText(params: {
  payloadCount: number;
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  // Tool-use terminal guard: when the last assistant message ended with a
  // tool-call stop reason, the model expected to continue after tool results.
  // Pre-tool text alone (payloadCount > 0) must not suppress the incomplete-
  // turn check in that case — the final post-tool response was never
  // produced. (#76477)
  const toolUseTerminal = params.attempt.lastAssistant?.stopReason === "toolUse";
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  // Unsigned thinking payloads count toward payloadCount but carry no user-visible
  // content; bypass the visible-text guard when unsigned thinking was the only output
  // so that incomplete-turn stall detection fires below. (#89787)
  const unsignedThinkingOnlyTerminal =
    params.payloadCount !== 0 &&
    !joinAssistantTexts(params.attempt.assistantTexts).length &&
    isUnsignedThinkingOnlyAssistantTurn(assistant);

  if (
    (params.payloadCount !== 0 && !toolUseTerminal && !unsignedThinkingOnlyTerminal) ||
    (params.aborted && params.externalAbort) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return null;
  }

  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) {
    return null;
  }

  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return null;
  }

  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) {
    return null;
  }

  if (hasAsyncStartedToolActivity(params.attempt.toolMetas)) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText: params.payloadCount > 0,
    lastAssistant: params.attempt.lastAssistant,
  });
  const reasoningOnlyAssistant = isReasoningOnlyAssistantTurn(assistant);
  const emptyResponseAssistant = isEmptyResponseAssistantTurn({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
  if (
    !incompleteTerminalAssistant &&
    !reasoningOnlyAssistant &&
    !unsignedThinkingOnlyTerminal &&
    !emptyResponseAssistant &&
    stopReason !== "error"
  ) {
    return null;
  }

  return resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects
    ? "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying."
    : "⚠️ Agent couldn't generate a response. Please try again.";
}

/**
 * Allows one retry when the provider returned no assistant turn at all and the
 * attempt has no side effects, active lifecycle items, delivery, or terminal
 * assistant/tool state.
 */
export function shouldRetryMissingAssistantTurn(params: {
  payloadCount: number;
  aborted: boolean;
  promptError?: unknown;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  if (
    params.payloadCount !== 0 ||
    params.aborted ||
    Boolean(params.promptError) ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.currentAttemptAssistant ||
    params.attempt.lastAssistant ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError
  ) {
    return false;
  }

  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) {
    return false;
  }

  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }

  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }

  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) {
    return false;
  }

  if (hasAsyncStartedToolActivity(params.attempt.toolMetas)) {
    return false;
  }

  if (
    (params.attempt.itemLifecycle?.startedCount ?? 0) > 0 ||
    (params.attempt.itemLifecycle?.activeCount ?? 0) > 0
  ) {
    return false;
  }

  return !resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects;
}

function joinAssistantTexts(assistantTexts?: readonly string[]): string {
  return (assistantTexts ?? []).join("\n\n").trim();
}

function hasOnlySilentAssistantReply(assistantTexts?: readonly string[]): boolean {
  const nonEmptyTexts = (assistantTexts ?? []).filter((text) => text.trim().length > 0);
  return (
    nonEmptyTexts.length > 0 &&
    nonEmptyTexts.every((text) => isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN))
  );
}

function hasAsyncStartedToolActivity(toolMetas?: readonly { asyncStarted?: boolean }[]): boolean {
  return (toolMetas ?? []).some((entry) => entry.asyncStarted === true);
}

function isToolResultRole(role: string): boolean {
  return role === "toolresult" || role === "tool_result" || role === "tool";
}

function readMessageTextContent(message: AgentMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  const text = collectTextContentBlocks(content)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join("\n");
  return text || undefined;
}

function readToolResultAggregatedText(message: AgentMessage): string | undefined {
  const aggregated = (message as { details?: { aggregated?: unknown } }).details?.aggregated;
  if (typeof aggregated !== "string") {
    return undefined;
  }
  const trimmed = aggregated.trim();
  return trimmed || undefined;
}

function hasTrailingSilentToolResult(messages: readonly AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    const role = normalizeLowercaseStringOrEmpty(message?.role);
    if (isToolResultRole(role)) {
      if ((message as { isError?: boolean }).isError === true) {
        return false;
      }
      const text = readMessageTextContent(message) ?? readToolResultAggregatedText(message);
      return isSilentReplyText(text, SILENT_REPLY_TOKEN);
    }
    if (role === "assistant" && !readMessageTextContent(message)) {
      continue;
    }
    return false;
  }
  return false;
}

/** Emits the silent-reply token for cron turns whose last successful tool result is silent. */
export function resolveSilentToolResultReplyPayload(params: {
  isCronTrigger: boolean;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: SilentToolResultAttempt;
}): { text: typeof SILENT_REPLY_TOKEN } | null {
  if (
    !params.isCronTrigger ||
    params.payloadCount !== 0 ||
    params.aborted ||
    params.timedOut ||
    (params.attempt.toolMetas?.length ?? 0) === 0 ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    (params.attempt.messagesSnapshot?.length ?? 0) === 0
  ) {
    return null;
  }

  return hasTrailingSilentToolResult(params.attempt.messagesSnapshot)
    ? { text: SILENT_REPLY_TOKEN }
    : null;
}

/**
 * Marks replay invalid whenever the recorded attempt might not be safe to
 * replay or the current run ended in a compaction/incomplete-turn state that
 * needs a fresh prompt boundary.
 */
export function resolveReplayInvalidFlag(params: {
  attempt: RunLivenessAttempt;
  incompleteTurnText?: string | null;
}): boolean {
  return (
    !resolveAttemptReplayMetadata(params.attempt).replaySafe ||
    params.attempt.promptErrorSource === "compaction" ||
    params.attempt.timedOutDuringCompaction ||
    Boolean(params.incompleteTurnText)
  );
}

/** Classifies the persisted run state used by session recovery and resume logic. */
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

function isReasoningOnlyAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-text";
}

// Unsigned thinking blocks have no cryptographic signature; assessLastAssistantMessage
// returns "incomplete-thinking" for them. Empty content also returns "incomplete-thinking",
// so the content.length > 0 guard is required to distinguish the two cases.
function isUnsignedThinkingOnlyAssistantTurn(message: unknown): boolean {
  if (message == null || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-thinking";
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
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
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

function isNonVisibleAssistantTurnEligibleForSilentReply(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "lastAssistant"
  >;
}): boolean {
  if (isEmptyResponseAssistantTurn(params)) {
    return true;
  }
  if (params.payloadCount !== 0) {
    return false;
  }
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return false;
  }
  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (!assistant || assistant.stopReason === "error") {
    return false;
  }
  if (
    isIncompleteTerminalAssistantTurn({
      hasAssistantVisibleText: false,
      lastAssistant: assistant,
    })
  ) {
    return false;
  }
  return isReasoningOnlyAssistantTurn(assistant);
}

function shouldSkipPlanningOnlyRetry(params: {
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  return Boolean(
    params.aborted ||
    params.timedOut ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    params.attempt.lastToolError ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects,
  );
}

/** Allows configured silent handling for replay-safe empty or reasoning-only assistant turns. */
export function shouldTreatEmptyAssistantReplyAsSilent(params: {
  allowEmptyAssistantReplyAsSilent?: boolean;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  if (!params.allowEmptyAssistantReplyAsSilent || shouldSkipPlanningOnlyRetry(params)) {
    return false;
  }
  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) {
    return false;
  }
  // Post-tool empty stops are ambiguous provider failures, not intentional silence.
  // Let the retry/incomplete-turn paths decide whether replay is safe.
  if (
    params.attempt.toolMetas.length > 0 &&
    isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    })
  ) {
    return false;
  }
  return isNonVisibleAssistantTurnEligibleForSilentReply({
    payloadCount: params.payloadCount,
    attempt: params.attempt,
  });
}

/**
 * Builds the retry instruction for reasoning-only turns that consumed provider
 * output budget but produced no visible assistant text.
 */
export function resolveReasoningOnlyRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): string | null {
  if (shouldSkipPlanningOnlyRetry(params)) {
    return null;
  }

  if (
    !shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;
  if (joinAssistantTexts(params.attempt.assistantTexts).length > 0) {
    return null;
  }
  if (assistant?.stopReason === "error") {
    return null;
  }
  if (!isReasoningOnlyAssistantTurn(assistant) && !isUnsignedThinkingOnlyAssistantTurn(assistant)) {
    return null;
  }

  return REASONING_ONLY_RETRY_INSTRUCTION;
}

/**
 * Builds the retry instruction for empty assistant turns when the provider/model
 * is eligible for non-visible turn recovery.
 */
export function resolveEmptyResponseRetryInstruction(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
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
    !isEmptyResponseAssistantTurn({
      payloadCount: params.payloadCount,
      attempt: params.attempt,
    })
  ) {
    return null;
  }

  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;
  if (
    assistant?.stopReason === "stop" &&
    OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(
      normalizeLowercaseStringOrEmpty(params.provider ?? ""),
    ) &&
    !hasPositiveOutputTokenUsage(assistant)
  ) {
    return null;
  }

  if (
    shouldApplyNonVisibleTurnRetryGuard({
      provider: params.provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      executionContract: params.executionContract,
    }) ||
    // Keep the generic zero-usage stop retry for providers that expose a
    // provider-neutral "nothing was generated" signal, even outside the
    // provider allowlist above.
    isZeroUsageEmptyStopAssistantTurn(assistant)
  ) {
    return EMPTY_RESPONSE_RETRY_INSTRUCTION;
  }

  return null;
}

function shouldApplyPlanningOnlyRetryGuard(params: {
  provider?: string;
  modelId?: string;
  executionContract?: string;
}): boolean {
  if (params.executionContract === "strict-agentic") {
    return true;
  }
  return isIncompleteTurnRecoverySupportedProviderModel({
    provider: params.provider,
    modelId: params.modelId,
  });
}

function shouldApplyNonVisibleTurnRetryGuard(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
}): boolean {
  if (shouldApplyPlanningOnlyRetryGuard(params)) {
    return true;
  }
  if (RETRY_GUARD_MODEL_APIS.has(normalizeLowercaseStringOrEmpty(params.modelApi ?? ""))) {
    return true;
  }
  // Non-visible final turns are narrower than planning-only turns: there is no
  // user text to classify, just a replay-safe empty/thinking-only result. Ollama
  // gets this continuation guard without getting the planning-only or ack
  // fast-path wording, which would be too opinionated for local models.
  return OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(
    normalizeLowercaseStringOrEmpty(params.provider ?? ""),
  );
}

function isIncompleteTurnRecoverySupportedProviderModel(params: {
  provider?: string;
  modelId?: string;
}): boolean {
  if (
    isStrictAgenticSupportedProviderModel({
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    return true;
  }
  const provider = normalizeLowercaseStringOrEmpty(params.provider ?? "");
  if (!GEMINI_INCOMPLETE_TURN_PROVIDER_IDS.has(provider)) {
    return false;
  }
  const modelId = typeof params.modelId === "string" ? params.modelId : "";
  return GEMINI_INCOMPLETE_TURN_MODEL_ID_PATTERN.test(stripProviderPrefix(modelId));
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

/** Detects short multilingual approval prompts that should continue execution immediately. */
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

/** Builds the fast-path execution instruction for short approval prompts like "go ahead". */
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
  const lines = normalizeStringEntries(text.split(/\r?\n/));
  const bulletLines = normalizeStringEntries(
    lines.map((line) => line.replace(/^[-*•]\s+|^\d+[.)]\s+/u, "")),
  );
  if (bulletLines.length >= 2) {
    return bulletLines.slice(0, 4);
  }
  return normalizeStringEntries(text.split(/(?<=[.!?])\s+/u)).slice(0, 4);
}

function hasStructuredPlanningOnlyFormat(text: string): boolean {
  const lines = normalizeStringEntries(text.split(/\r?\n/));
  if (lines.length === 0) {
    return false;
  }
  const bulletLineCount = lines.filter((line) => PLANNING_ONLY_BULLET_RE.test(line)).length;
  const hasPlanningCueLine = lines.some((line) => PLANNING_ONLY_PROMISE_RE.test(line));
  const hasPlanningHeading = PLANNING_ONLY_HEADING_RE.test(lines[0] ?? "");
  return (hasPlanningHeading && hasPlanningCueLine) || (bulletLineCount >= 2 && hasPlanningCueLine);
}

/** Extracts the visible plan text and normalized step list from a plan-only reply. */
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

function normalizePlanningToolMetas(
  toolMetas?: PlanningOnlyAttempt["toolMetas"],
): PlanningOnlyAttempt["toolMetas"] {
  return toolMetas ?? [];
}

function countPlanOnlyToolMetas(toolMetas?: PlanningOnlyAttempt["toolMetas"]): number {
  return normalizePlanningToolMetas(toolMetas).filter((entry) => entry.toolName === "update_plan")
    .length;
}

function countNonPlanToolCalls(toolMetas?: PlanningOnlyAttempt["toolMetas"]): number {
  return normalizePlanningToolMetas(toolMetas).filter((entry) => entry.toolName !== "update_plan")
    .length;
}

function hasNonPlanToolActivity(toolMetas?: PlanningOnlyAttempt["toolMetas"]): boolean {
  return normalizePlanningToolMetas(toolMetas).some((entry) => entry.toolName !== "update_plan");
}

function hasSingleRetrySafeNonPlanTool(toolMetas?: PlanningOnlyAttempt["toolMetas"]): boolean {
  const nonPlanToolNames = normalizePlanningToolMetas(toolMetas)
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
  toolMetas?: PlanningOnlyAttempt["toolMetas"];
  assistantTexts?: readonly string[];
}): boolean {
  const nonPlanCount = countNonPlanToolCalls(params.toolMetas);
  if (nonPlanCount !== 1) {
    return false;
  }
  const text = (params.assistantTexts ?? []).join("\n\n").trim();
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

/** Retry budget for plan-only recovery, higher for strict-agentic models. */
export function resolvePlanningOnlyRetryLimit(
  executionContract?: EmbeddedAgentExecutionContract,
): number {
  return executionContract === "strict-agentic"
    ? STRICT_AGENTIC_PLANNING_ONLY_RETRY_LIMIT
    : DEFAULT_PLANNING_ONLY_RETRY_LIMIT;
}

/**
 * Builds the retry instruction for assistant turns that only promised a plan
 * instead of taking concrete action. The guard excludes real side effects,
 * non-actionable prompts, explicit completions, and multi-tool progress.
 */
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
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    hasMessagingToolDeliveryEvidence(params.attempt) ||
    params.attempt.lastToolError ||
    (hasNonPlanToolActivity(params.attempt.toolMetas) && !allowSingleActionRetryBypass) ||
    ((params.attempt.itemLifecycle?.startedCount ?? 0) > planOnlyToolMetaCount &&
      !allowSingleActionRetryBypass) ||
    resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects
  ) {
    return null;
  }

  const stopReason = params.attempt.lastAssistant?.stopReason;
  if (stopReason && stopReason !== "stop") {
    return null;
  }

  const text = (params.attempt.assistantTexts ?? []).join("\n\n").trim();
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
