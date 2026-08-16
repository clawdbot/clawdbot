import type { Context, Model } from "@openclaw/llm-core";
import { convertMessages, hasToolCallHistory } from "../openai-completions-messages.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { resolveCacheRetention } from "../providers/cache-retention.js";
import {
  isOpenAIGpt54MiniModel,
  isOpenAIGpt55Model,
  isOpenAIGpt56Model,
  resolveOpenAIReasoningEffortForModel,
  type OpenAIReasoningEffort,
} from "../providers/openai-reasoning-effort.js";
import {
  resolveOpenAICompletionsResponseFormat,
  shouldOmitOllamaCompatResponseFormat,
} from "../providers/openai-response-format.js";
import {
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
} from "../providers/openai-tool-projection.js";
import { normalizeOpenAIStrictToolParameters } from "../providers/openai-tool-schema.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { resolveOpenAIStrictToolSetting, resolveProviderEndpoint } from "./host-policy.js";
import { resolveMaxTokensParam } from "./model-max-tokens-params.js";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { isAzureOpenAICompatibleHost } from "./openai-completions-host.js";
import { applyCompletionsReplay } from "./openai-completions-replay.js";
import {
  flattenCompletionMessagesToStringContent,
  stripCompletionMessagesToRoleContent,
} from "./openai-completions-string-content.js";
import {
  getCompat,
  resolveOpenAIStrictToolFlagWithDiagnostics,
} from "./openai-transport-params.js";
import {
  isOpenAICompletionsThinkingEnabled,
  log,
  resolvePromptCacheKey,
  sortTransportToolsByName,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  supportsModelTools,
} from "./transport-utils.js";

function isKnownOpenAICompletionsEndpoint(model: Pick<Model, "baseUrl">): boolean {
  if (!model.baseUrl.trim()) {
    return true;
  }
  const endpointClass = resolveProviderEndpoint(model.baseUrl).endpointClass;
  if (endpointClass === "openai-public" || endpointClass === "azure-openai") {
    return true;
  }
  try {
    return isAzureOpenAICompatibleHost(new URL(model.baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveOpenAICompletionsReasoningEffort(options: OpenAICompletionsOptions | undefined) {
  return options?.reasoningEffort ?? options?.reasoning ?? "high";
}

function resolveOpenAICompletionsMaxTokens(
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
): { maxTokens: number | undefined; clampToModelMaxTokens: boolean } {
  if (options?.maxTokens) {
    return { maxTokens: options.maxTokens, clampToModelMaxTokens: true };
  }
  const paramsMaxTokens = resolveMaxTokensParam(
    (model as { params?: Record<string, unknown> }).params,
  );
  if (paramsMaxTokens) {
    return { maxTokens: paramsMaxTokens, clampToModelMaxTokens: false };
  }
  return { maxTokens: model.maxTokens, clampToModelMaxTokens: false };
}

function resolveOpenAICompletionsModelMaxTokens(model: OpenAIModeModel): number | undefined {
  return typeof model.maxTokens === "number" &&
    Number.isFinite(model.maxTokens) &&
    model.maxTokens > 0
    ? Math.floor(model.maxTokens)
    : undefined;
}

const OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN = 1.25;
const OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE = 8_000;

// Used only to bound `max_completion_tokens` below the effective context cap
// for strict OpenAI-compatible servers (e.g. vLLM, StepFun). The CJK-aware
// helper avoids undercounting non-Latin prompts enough to trigger server-side
// context rejections; wrong-high here just trims output a little. Estimate the
// final shaped payload, not the raw context, so compat transforms and dropped
// replay turns are reflected in the output cap.
function estimateOpenAICompletionsInputTokens(payload: {
  messages?: unknown;
  tools?: unknown;
  response_format?: unknown;
}): number {
  let adjustedChars = 0;
  adjustedChars += estimateOpenAICompletionsMessagesChars(payload.messages);
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    try {
      adjustedChars += estimateStringChars(JSON.stringify(payload.tools));
    } catch {
      adjustedChars += 1024;
    }
  }
  if (payload.response_format !== undefined) {
    try {
      adjustedChars += estimateStringChars(JSON.stringify(payload.response_format));
    } catch {
      adjustedChars += 256;
    }
  }
  return Math.ceil(
    (adjustedChars / CHARS_PER_TOKEN_ESTIMATE) * OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN,
  );
}

function estimateOpenAICompletionsMessagesChars(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let adjustedChars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    adjustedChars += estimateOpenAICompletionsContentChars(record.content);
    // Reasoning replay fields (reasoning_content, reasoning_details, etc.) are
    // sent for continuity but are not primary input the model re-tokenizes.
    // For proxy-like endpoints (vLLM, LiteLLM) they are typically prefix-cached
    // server-side. Counting them inflates the estimate unboundedly across long
    // sessions with reasoning models, eventually clamping maxTokens to 1.
    if (record.tool_calls !== undefined) {
      try {
        adjustedChars += estimateStringChars(JSON.stringify(record.tool_calls));
      } catch {
        adjustedChars += 256;
      }
    }
  }
  return adjustedChars;
}

function estimateOpenAICompletionsContentChars(value: unknown): number {
  if (typeof value === "string") {
    return estimateStringChars(value);
  }
  if (!Array.isArray(value)) {
    return 0;
  }
  let adjustedChars = 0;
  for (const block of value) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "image_url" || record.type === "input_image") {
      adjustedChars += OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE;
      continue;
    }
    const text = record.text;
    if (typeof text === "string") {
      adjustedChars += estimateStringChars(text);
      continue;
    }
    try {
      adjustedChars += estimateStringChars(JSON.stringify(block));
    } catch {
      adjustedChars += 256;
    }
  }
  return adjustedChars;
}

function resolveOpenAICompletionsEffectiveContextTokens(
  model: OpenAIModeModel,
): number | undefined {
  const contextTokens = (model as { contextTokens?: number }).contextTokens;
  if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) {
    return contextTokens;
  }
  return typeof model.contextWindow === "number" &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0
    ? model.contextWindow
    : undefined;
}

function isQwenOpenAICompletionsThinkingFormat(format: string): boolean {
  return format === "qwen" || format === "qwen-chat-template";
}

function setQwenChatTemplateThinking(params: Record<string, unknown>, enabled: boolean): void {
  const existing = params.chat_template_kwargs;
  params.chat_template_kwargs =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), enable_thinking: enabled }
      : { enable_thinking: enabled };
}

function applyQwenOpenAICompletionsThinkingParams(params: {
  compatThinkingFormat: string;
  modelReasoning: boolean;
  payload: Record<string, unknown>;
  requestedEffort: OpenAIReasoningEffort;
}): boolean {
  if (
    !params.modelReasoning ||
    !isQwenOpenAICompletionsThinkingFormat(params.compatThinkingFormat)
  ) {
    return false;
  }
  const enabled = isOpenAICompletionsThinkingEnabled(params.requestedEffort);
  if (params.compatThinkingFormat === "qwen-chat-template") {
    setQwenChatTemplateThinking(params.payload, enabled);
  } else {
    params.payload.enable_thinking = enabled;
  }
  return true;
}

function applyTogetherOpenAICompletionsThinkingParams(params: {
  compatThinkingFormat: string;
  modelReasoning: boolean;
  payload: Record<string, unknown>;
  requestedEffort: OpenAIReasoningEffort;
}): void {
  if (!params.modelReasoning || params.compatThinkingFormat !== "together") {
    return;
  }
  params.payload.reasoning = {
    enabled: isOpenAICompletionsThinkingEnabled(params.requestedEffort),
  };
}

function convertTools(
  tools: NonNullable<Context["tools"]>,
  compat: ReturnType<typeof getCompat>,
  model: OpenAIModeModel,
) {
  const projection = projectOpenAITools(tools);
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(
    projection,
    resolveOpenAIStrictToolSetting(model, {
      transport: "stream",
      supportsStrictMode: compat?.supportsStrictMode,
    }),
    {
      transport: "completions",
      model,
    },
  );
  return {
    projection,
    tools: sortTransportToolsByName(projection.tools).map((tool) => {
      const functionTool: {
        name: string;
        description: string | undefined;
        parameters: ReturnType<typeof normalizeOpenAIStrictToolParameters>;
        strict?: boolean;
      } = {
        name: tool.name,
        description: tool.description,
        parameters: normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model.compat,
        ),
      };
      if (strict !== undefined) {
        functionTool.strict = strict;
      }
      return {
        type: "function",
        function: functionTool,
      };
    }),
  };
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  const compat = getCompat(model);
  const compatDetection = detectOpenAICompletionsCompat(model);
  const completionsContext = context.systemPrompt
    ? {
        ...context,
        systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
      }
    : context;
  let messages = convertMessages(model as never, completionsContext, compat as never);
  applyCompletionsReplay(messages as unknown[], context, model, compat);
  if (compat.strictMessageKeys) {
    messages = stripCompletionMessagesToRoleContent(messages) as typeof messages;
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: compat.requiresStringContent
      ? flattenCompletionMessagesToStringContent(messages)
      : messages,
    stream: true,
  };
  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (compat.supportsPromptCacheKey && promptCacheKey) {
    params.prompt_cache_key = promptCacheKey;
    // When the caller explicitly opted into long retention, forward the
    // canonical prompt_cache_retention value alongside the cache key so
    // OpenAI-compatible completions backends (oMLX, llama.cpp, official
    // OpenAI, etc.) can honor the 24h prefix-cache lifetime. Without this
    // the key reaches the wire but the retention preference is silently dropped.
    if (cacheRetention === "long" && compat.supportsLongCacheRetention) {
      params.prompt_cache_retention = "24h";
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.topP !== undefined) {
    params.top_p = options.topP;
  }
  const responseFormat = resolveOpenAICompletionsResponseFormat(
    shouldOmitOllamaCompatResponseFormat({
      provider: model.provider,
      baseUrl: model.baseUrl,
      hasTools: () => Boolean(context.tools?.length),
    })
      ? undefined
      : options?.responseFormat,
    compat.supportsJsonSchemaResponseFormat,
  );
  if (responseFormat !== undefined) {
    params.response_format = responseFormat;
  }
  if (options?.frequencyPenalty !== undefined) {
    params.frequency_penalty = options.frequencyPenalty;
  }
  if (options?.presencePenalty !== undefined) {
    params.presence_penalty = options.presencePenalty;
  }
  if (options?.seed !== undefined) {
    params.seed = options.seed;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop = options.stop;
  }
  if (supportsModelTools(model)) {
    if (context.tools) {
      const converted = convertTools(context.tools, compat, model);
      if (
        converted.tools.length > 0 ||
        (converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0)
      ) {
        params.tools = converted.tools;
      } else if (hasToolCallHistory(context.messages)) {
        params.tools = [];
      }
      if (options?.toolChoice) {
        const toolChoice = reconcileOpenAICompletionsToolChoice(
          options.toolChoice,
          converted.projection,
        );
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      } else if (
        compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
        Array.isArray(params.tools) &&
        params.tools.length > 0
      ) {
        params.tool_choice = "auto";
      }
    } else if (hasToolCallHistory(context.messages)) {
      params.tools = [];
    }
    if (
      compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
      Array.isArray(params.tools) &&
      params.tools.length === 0
    ) {
      delete params.tools;
      delete params.tool_choice;
    }
  }
  {
    const maxTokenBudget = resolveOpenAICompletionsMaxTokens(model, options);
    const effectiveMaxTokens = maxTokenBudget.maxTokens;
    const effectiveContextTokens = resolveOpenAICompletionsEffectiveContextTokens(model);
    let clampedMaxTokens = effectiveMaxTokens;
    const modelMaxTokens = resolveOpenAICompletionsModelMaxTokens(model);
    if (
      maxTokenBudget.clampToModelMaxTokens &&
      clampedMaxTokens !== undefined &&
      modelMaxTokens !== undefined &&
      clampedMaxTokens > modelMaxTokens
    ) {
      clampedMaxTokens = modelMaxTokens;
      emitModelTransportDebug(
        log,
        `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
          `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
          `modelMaxTokens=${modelMaxTokens}`,
      );
    }
    if (
      compatDetection.capabilities.usesExplicitProxyLikeEndpoint &&
      clampedMaxTokens !== undefined &&
      effectiveContextTokens !== undefined
    ) {
      const estimatedInputTokens = estimateOpenAICompletionsInputTokens(params);
      const remainingBudget = Math.max(1, effectiveContextTokens - estimatedInputTokens - 1);
      if (clampedMaxTokens > remainingBudget) {
        clampedMaxTokens = remainingBudget;
        emitModelTransportDebug(
          log,
          `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} ` +
            `model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} ` +
            `effectiveContext=${effectiveContextTokens} estimatedInput=${estimatedInputTokens}`,
        );
      }
    }
    if (clampedMaxTokens) {
      if (compat.maxTokensField === "max_tokens") {
        params.max_tokens = clampedMaxTokens;
      } else {
        params.max_completion_tokens = clampedMaxTokens;
      }
    }
  }
  const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
  const resolvedCompletionsReasoningEffort = completionsReasoningEffort
    ? resolveOpenAIReasoningEffortForModel({
        model,
        effort: completionsReasoningEffort,
        fallbackMap: compat.reasoningEffortMap,
      })
    : undefined;
  const omitChatCompletionsToolReasoningEffort =
    Array.isArray(params.tools) &&
    params.tools.length > 0 &&
    (isOpenAIGpt54MiniModel(model) ||
      (isOpenAIGpt55Model(model) && isKnownOpenAICompletionsEndpoint(model)));
  const disableChatCompletionsToolReasoning =
    Array.isArray(params.tools) &&
    params.tools.length > 0 &&
    isOpenAIGpt56Model(model) &&
    isKnownOpenAICompletionsEndpoint(model);
  const handledQwenThinkingFormat = applyQwenOpenAICompletionsThinkingParams({
    compatThinkingFormat: compat.thinkingFormat,
    modelReasoning: model.reasoning,
    payload: params,
    requestedEffort: completionsReasoningEffort,
  });
  applyTogetherOpenAICompletionsThinkingParams({
    compatThinkingFormat: compat.thinkingFormat,
    modelReasoning: model.reasoning,
    payload: params,
    requestedEffort: completionsReasoningEffort,
  });
  if (disableChatCompletionsToolReasoning) {
    // GPT-5.6 Chat Completions defaults reasoning on, but rejects function
    // tools unless reasoning is explicitly disabled.
    params.reasoning_effort = "none";
  } else if (
    compat.thinkingFormat === "openrouter" &&
    model.reasoning &&
    resolvedCompletionsReasoningEffort
  ) {
    params.reasoning = {
      effort: resolvedCompletionsReasoningEffort,
    };
  } else if (
    resolvedCompletionsReasoningEffort &&
    model.reasoning &&
    compat.supportsReasoningEffort &&
    !handledQwenThinkingFormat &&
    !omitChatCompletionsToolReasoningEffort
  ) {
    params.reasoning_effort = resolvedCompletionsReasoningEffort;
  }
  return params;
}
