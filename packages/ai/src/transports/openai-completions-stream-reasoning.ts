import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import {
  isOpenAICompletionsThinkingEnabled,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";

function resolveOpenAICompletionsReasoningEffort(options: OpenAICompletionsOptions | undefined) {
  return options?.reasoningEffort ?? options?.reasoning ?? "high";
}

export function shouldEmitOpenAICompletionsReasoning(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
) {
  if (!model.reasoning) {
    return false;
  }
  const effort = resolveOpenAICompletionsReasoningEffort(options);
  if (!effort || !isOpenAICompletionsThinkingEnabled(effort)) {
    return false;
  }
  return true;
}

export function hasOpenAICompletionsReasoningUsageActivity(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
) {
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  return (
    typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens > 0
  );
}
