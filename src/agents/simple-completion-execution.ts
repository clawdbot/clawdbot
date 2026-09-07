/** Executes an already-prepared model without importing model/auth preparation. */
import {
  reasoningTagTextPolicy,
  supportsOpenAIReasoningEffort,
} from "@openclaw/ai/internal/openai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import {
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
} from "@openclaw/llm-core";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindModelLlmRuntime,
  getModelCompletionTransport,
  getModelCompletionRunner,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import type {
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  ThinkingLevel as SimpleCompletionThinkingLevel,
} from "../llm/types.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import { isOpenAIProvider } from "./openai-routing.js";

type SimpleCompletionModelOptions = {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkLevel | SimpleCompletionThinkingLevel;
  strictReasoningTags?: boolean;
  signal?: AbortSignal;
};

export async function completeWithPreparedSimpleCompletionModelCore(params: {
  assertCurrent?: () => void;
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
}): Promise<AssistantMessage> {
  const runCompletion = getModelCompletionRunner(params.model);
  return await (runCompletion
    ? runCompletion(() => executePreparedSimpleCompletion(params))
    : executePreparedSimpleCompletion(params));
}

async function executePreparedSimpleCompletion(
  params: Parameters<typeof completeWithPreparedSimpleCompletionModelCore>[0],
): Promise<AssistantMessage> {
  const runtime = getModelLlmRuntime(params.model);
  let completionModel =
    getModelCompletionTransport(params.model) ??
    prepareModelForSimpleCompletion({
      // The SDK facade owns legacy shared-transport resources for bare-model callers.
      // Prepared host paths carry their exact lifecycle runtime.
      apiRegistry: runtime?.registry ?? defaultApiRegistry,
      model: params.model,
      cfg: params.cfg,
    });
  if (runtime) {
    completionModel = bindModelLlmRuntime(completionModel, runtime);
  }
  const { reasoning: rawReasoning, strictReasoningTags, ...options } = params.options ?? {};
  const reasoning = normalizeSimpleCompletionReasoning(rawReasoning, completionModel);
  const completionOptions = {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
  };
  if (strictReasoningTags) {
    reasoningTagTextPolicy.markStrict(completionOptions);
  }
  return await completeSimple(
    completionModel,
    params.context,
    completionOptions,
    params.assertCurrent,
  );
}

function normalizeSimpleCompletionReasoning(
  reasoning: SimpleCompletionModelOptions["reasoning"],
  model: Model,
): ModelThinkingLevel | undefined {
  switch (reasoning) {
    case undefined:
      return undefined;
    case "off":
      return resolveClaudeSonnet5ModelIdentity(model) || resolveClaudeOpus5ModelIdentity(model)
        ? "off"
        : undefined;
    case "adaptive":
      return "medium";
    case "ultra":
    case "max":
      return isOpenAIProvider(model.provider) && supportsOpenAIReasoningEffort(model, "max")
        ? "max"
        : "xhigh";
    default:
      return reasoning;
  }
}
