/** Classifies terminal assistant visibility and provider retry eligibility. */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { extractEmbeddedAssistantText } from "../../embedded-agent-utils.js";
import {
  isStrictAgenticSupportedProviderModel,
  stripProviderPrefix,
} from "../../execution-contract.js";
import type { AgentMessage } from "../../runtime/index.js";
import { assessLastAssistantMessage } from "../thinking.js";
import { resolveCurrentAttemptAssistant } from "./attempt-terminal-evidence.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export type IncompleteTurnAttempt = Pick<
  EmbeddedRunAttemptResult,
  | "assistantTexts"
  | "clientToolCalls"
  | "currentAttemptAssistant"
  | "currentAttemptCompletedAssistant"
  | "yieldDetected"
  | "didSendDeterministicApprovalPrompt"
  | "heartbeatToolResponse"
  | "toolMediaUrls"
  | "toolAudioAsVoice"
  | "toolTrustedLocalMedia"
  | "hasToolMediaBlockReply"
  | "didDeliverSourceReplyViaMessageTool"
  | "messagingToolSourceReplyPayloads"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "lastToolError"
  | "itemLifecycle"
  | "messagesSnapshot"
  | "replayMetadata"
  | "currentAttemptReplayMetadata"
  | "settledTurnFinalizationContext"
  | "terminal"
  | "toolMetas"
> &
  Partial<Pick<EmbeddedRunAttemptResult, "acceptedSessionSpawns">>;

function readAssistantSnapshotText(message: AgentMessage): string {
  return message.role === "assistant" ? extractEmbeddedAssistantText(message).trim() : "";
}

/** Keeps pre-tool commentary distinct from a composed answer at both recovery gates. */
export function hasComposedVisibleAnswerAfterSettledTools(params: {
  assistantTexts: readonly string[];
  messagesSnapshot: EmbeddedRunAttemptResult["messagesSnapshot"];
}): boolean {
  // Prior turns cannot explain this attempt's visible subscription text.
  const latestUserIndex = params.messagesSnapshot.findLastIndex(
    (message) => message.role === "user",
  );
  const currentMessages = params.messagesSnapshot.slice(latestUserIndex + 1);
  const lastToolResultIndex = currentMessages.findLastIndex(
    (message) => message.role === "toolResult",
  );
  if (lastToolResultIndex < 0) {
    return params.assistantTexts.some((text) => text.trim().length > 0);
  }
  if (
    currentMessages
      .slice(lastToolResultIndex + 1)
      .some((message) => readAssistantSnapshotText(message).length > 0)
  ) {
    return true;
  }
  // A repeated fragment is ambiguous; only whole commentary messages explain text.
  const preToolTexts = new Set(
    currentMessages.slice(0, lastToolResultIndex).map(readAssistantSnapshotText),
  );
  return params.assistantTexts.some((text) => {
    const trimmed = text.trim();
    return trimmed.length > 0 && !preToolTexts.has(trimmed);
  });
}

export function hasPositiveOutputTokenUsage(message: AgentMessage | null): boolean {
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

export function isIncompleteTerminalAssistantTurn(params: {
  hasAssistantVisibleText: boolean;
  hasTerminalOutput?: boolean;
  lastAssistant?: { stopReason?: string } | null;
}): boolean {
  const stopReason = params.lastAssistant?.stopReason;
  // Tool-use expects a post-tool continuation, so partial visible text completes
  // nothing. Length is different: the output budget ended, no continuation is
  // pending, and any visible text the model did emit is the answer so far. Only
  // a length stop with nothing to show is an incomplete turn.
  return (
    stopReason === "toolUse" ||
    (stopReason === "length" && !params.hasTerminalOutput && !params.hasAssistantVisibleText)
  );
}

const GEMINI_INCOMPLETE_TURN_PROVIDER_IDS = new Set([
  "google",
  "google-vertex",
  "google-antigravity",
  "google-gemini-cli",
]);
const GEMINI_INCOMPLETE_TURN_MODEL_ID_PATTERN = /^gemini(?:[.-]|$)/;
// Ollama native `/api/chat` can finish with only thinking/internal blocks when constrained.
const OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN = /^ollama(?:-|$)/;

export function isOllamaIncompleteTurnProvider(provider?: string): boolean {
  return OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(
    normalizeLowercaseStringOrEmpty(provider ?? ""),
  );
}
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
  "openclaw-openai-chatgpt-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);
export function joinAssistantTexts(assistantTexts?: readonly string[]): string {
  return (assistantTexts ?? []).join("\n\n").trim();
}

export function hasOnlySilentAssistantReply(assistantTexts?: readonly string[]): boolean {
  const nonEmptyTexts = (assistantTexts ?? []).filter((text) => text.trim().length > 0);
  return (
    nonEmptyTexts.length > 0 &&
    nonEmptyTexts.every((text) => isSilentReplyPayloadText(text, SILENT_REPLY_TOKEN))
  );
}

export function isReasoningOnlyAssistantTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-text";
}

// Unsigned thinking blocks have no cryptographic signature; assessLastAssistantMessage
// returns "incomplete-thinking" for them. Empty content also returns "incomplete-thinking",
// so the content.length > 0 guard is required to distinguish the two cases.
export function isUnsignedThinkingOnlyAssistantTurn(message: unknown): boolean {
  if (message == null || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return assessLastAssistantMessage(message as AgentMessage) === "incomplete-thinking";
}

export function shouldApplyNonVisibleTurnRetryGuard(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
}): boolean {
  if (
    params.executionContract === "strict-agentic" ||
    isIncompleteTurnRecoverySupportedProviderModel({
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    return true;
  }
  if (RETRY_GUARD_MODEL_APIS.has(normalizeLowercaseStringOrEmpty(params.modelApi ?? ""))) {
    return true;
  }
  // This path uses provider output structure only: no user or assistant prose classification.
  return isOllamaIncompleteTurnProvider(params.provider);
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

export function classifyAssistantTurn(params: {
  payloadCount: number;
  attempt: Pick<
    IncompleteTurnAttempt,
    "assistantTexts" | "currentAttemptAssistant" | "currentAttemptCompletedAssistant"
  >;
}) {
  const assistant = resolveCurrentAttemptAssistant(params.attempt);
  const visibleText = joinAssistantTexts(params.attempt.assistantTexts);
  const reasoningOnly = isReasoningOnlyAssistantTurn(assistant);
  const nonVisibleEligibleForSilentReply =
    params.payloadCount === 0 &&
    visibleText.length === 0 &&
    assistant?.stopReason !== "error" &&
    !isIncompleteTerminalAssistantTurn({
      hasAssistantVisibleText: false,
      lastAssistant: assistant,
    });
  return {
    assistant,
    visibleText,
    reasoningOnly,
    emptyResponse: nonVisibleEligibleForSilentReply && !reasoningOnly,
    nonVisibleEligibleForSilentReply,
  };
}
