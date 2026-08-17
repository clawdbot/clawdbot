import type { Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  FunctionTool,
  ResponseFormatTextConfig,
  ResponseInput,
} from "openai/resources/responses/responses.js";
import { resolveCacheRetention } from "../providers/cache-retention.js";
import {
  normalizeOpenAIReasoningEffort,
  resolveOpenAIReasoningEffortForModel,
  type OpenAIApiReasoningEffort,
} from "../providers/openai-reasoning-effort.js";
import {
  projectOpenAITools,
  reconcileOpenAIResponsesToolChoice,
  type OpenAIToolProjection,
} from "../providers/openai-tool-projection.js";
import { normalizeOpenAIStrictToolParameters } from "../providers/openai-tool-schema.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { resolveOpenAIStrictToolSetting } from "./host-policy.js";
import type { OpenAIResponsesReplayMode } from "./openai-responses-compaction-replay.js";
import {
  OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS,
  OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT,
  type OpenAIResponsesOptions,
  type OpenAIResponsesRequestParams,
} from "./openai-responses-contracts.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import {
  buildResponsesInputMessage,
  convertResponsesMessages,
} from "./openai-responses-replay-internal.js";
import {
  getCompat,
  isOpenAICodexResponsesModel,
  resolveOpenAIStrictToolFlagWithDiagnostics,
  usesNativeOpenAICodexResponsesBackend,
} from "./openai-transport-params.js";
import {
  resolvePromptCacheKey,
  sortTransportToolsByName,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

const OPENAI_RESPONSES_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "opencode",
  "azure-openai-responses",
  "github-copilot",
]);

function convertResponsesTools(
  tools: NonNullable<Context["tools"]>,
  model: OpenAIModeModel,
  options?: { strict?: boolean | null },
): { projection: OpenAIToolProjection; tools: FunctionTool[] } {
  const projection = projectOpenAITools(tools);
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(projection, options?.strict, {
    transport: "responses",
    model,
  });
  return {
    projection,
    tools: sortTransportToolsByName(projection.tools).map((tool): FunctionTool => {
      const result = {
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model.compat,
        ),
      } as FunctionTool;
      if (strict !== undefined) {
        result.strict = strict;
      }
      return result;
    }),
  };
}

function getPromptCacheRetention(
  baseUrl: string | undefined,
  cacheRetention: "short" | "long" | "none",
) {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return baseUrl?.includes("api.openai.com") ? "24h" : undefined;
}

function resolveOpenAIReasoningEffort(
  options: OpenAIResponsesOptions | undefined,
): OpenAIApiReasoningEffort {
  return normalizeOpenAIReasoningEffort(
    options?.reasoningEffort ?? options?.reasoning ?? "high",
  ) as OpenAIApiReasoningEffort;
}

function hasResponsesWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => {
    if (!isRecord(tool)) {
      return false;
    }
    if (tool.type === "web_search") {
      return true;
    }
    if (tool.type === "function" && tool.name === "web_search") {
      return true;
    }
    const fn = tool.function;
    return isRecord(fn) && fn.name === "web_search";
  });
}

function raiseMinimalReasoningForResponsesWebSearch(params: {
  model: Model;
  effort: OpenAIApiReasoningEffort;
  tools: unknown;
}): OpenAIApiReasoningEffort {
  if (params.effort !== "minimal" || !hasResponsesWebSearchTool(params.tools)) {
    return params.effort;
  }
  for (const effort of ["low", "medium", "high"] as const) {
    const resolved = resolveOpenAIReasoningEffortForModel({
      model: params.model,
      effort,
    });
    if (resolved && resolved !== "none" && resolved !== "minimal") {
      return resolved;
    }
  }
  return params.effort;
}

const OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS = [
  "max_output_tokens",
  "metadata",
  "prompt_cache_retention",
  "service_tier",
  "temperature",
  "top_p",
] as const;

function stripOpenAICodexResponsesUnsupportedTextFields(params: Record<string, unknown>): void {
  const text = params.text;
  if (!text || typeof text !== "object" || Array.isArray(text)) {
    return;
  }
  const sanitizedText = { ...(text as Record<string, unknown>) };
  delete sanitizedText.format;
  if (Object.keys(sanitizedText).length > 0) {
    params.text = sanitizedText;
  } else {
    delete params.text;
  }
}

export function sanitizeOpenAICodexResponsesParams<T extends Record<string, unknown>>(
  model: Model,
  params: T,
): T {
  if (!usesNativeOpenAICodexResponsesBackend(model)) {
    return params;
  }
  for (const key of OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS) {
    delete params[key];
  }
  stripOpenAICodexResponsesUnsupportedTextFields(params);
  return params;
}

function buildOpenAICodexResponsesInstructions(context: Context): string | undefined {
  if (!context.systemPrompt) {
    return undefined;
  }
  return sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt));
}

function resolveOpenAICodexResponsesInstructions(
  model: Model,
  context: Context,
): string | undefined {
  const instructions = buildOpenAICodexResponsesInstructions(context);
  if (instructions && instructions.trim().length > 0) {
    return instructions;
  }
  return usesNativeOpenAICodexResponsesBackend(model)
    ? OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS
    : undefined;
}

function ensureOpenAICodexResponsesInput(messages: ResponseInput, context: Context): void {
  if (messages.length > 0 || !context.systemPrompt) {
    return;
  }
  const text = buildOpenAICodexResponsesInstructions(context);
  if (!text) {
    throw new Error(
      "OpenAI Codex Responses requires non-empty input when only systemPrompt is provided.",
    );
  }
  messages.push(
    buildResponsesInputMessage("user", [
      { type: "input_text", text: OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT },
    ]),
  );
}

function resolveOpenAIResponsesTextFormat(
  responseFormat: Record<string, unknown>,
): ResponseFormatTextConfig {
  if (
    responseFormat.type === "json_schema" &&
    responseFormat.json_schema &&
    typeof responseFormat.json_schema === "object" &&
    !Array.isArray(responseFormat.json_schema)
  ) {
    return {
      ...(responseFormat.json_schema as Record<string, unknown>),
      type: "json_schema",
    } as unknown as ResponseFormatTextConfig;
  }
  return responseFormat as unknown as ResponseFormatTextConfig;
}

function convertOpenAIResponsesMessagesForRequest(
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  replayMode: OpenAIResponsesReplayMode,
): ResponseInput {
  const isCodexResponses = isOpenAICodexResponsesModel(model);
  const isNativeCodexResponses = usesNativeOpenAICodexResponsesBackend(model);
  const compat = getCompat(model as OpenAIModeModel);
  const supportsDeveloperRole =
    typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const policyAllowsReplayIds =
    payloadPolicy.explicitStore !== false && !payloadPolicy.shouldStripStore;
  const replayResponsesItemIds =
    !isNativeCodexResponses && (options?.replayResponsesItemIds ?? policyAllowsReplayIds);
  return convertResponsesMessages(model, context, OPENAI_RESPONSES_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: !isCodexResponses,
    supportsDeveloperRole,
    replayReasoningItems: true,
    replayResponsesItemIds,
    authProfileId: options?.authProfileId,
    sessionId: options?.sessionId,
    replayMode,
  });
}

export function buildOpenAIResponsesParams(
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  metadata?: Record<string, string>,
  replayMode: OpenAIResponsesReplayMode = "checkpoint",
) {
  const isCodexResponses = isOpenAICodexResponsesModel(model);
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const messages = convertOpenAIResponsesMessagesForRequest(model, context, options, replayMode);
  if (isCodexResponses) {
    ensureOpenAICodexResponsesInput(messages, context);
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const params: OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: promptCacheKey,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    ...(isCodexResponses
      ? { instructions: resolveOpenAICodexResponsesInstructions(model, context) }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
  const effectiveMaxTokens = options?.maxTokens || model.maxTokens;
  if (effectiveMaxTokens) {
    params.max_output_tokens = effectiveMaxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.topP !== undefined) {
    params.top_p = options.topP;
  }
  if (options?.responseFormat !== undefined) {
    params.text = {
      ...params.text,
      format: resolveOpenAIResponsesTextFormat(options.responseFormat),
    };
  }
  if (options?.serviceTier !== undefined && payloadPolicy.allowsServiceTier) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    const converted = convertResponsesTools(context.tools, model as OpenAIModeModel, {
      strict: resolveOpenAIStrictToolSetting(model as OpenAIModeModel, {
        transport: "stream",
      }),
    });
    if (
      converted.tools.length > 0 ||
      (converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0)
    ) {
      params.tools = converted.tools;
    }
    if (options?.toolChoice) {
      const toolChoice = reconcileOpenAIResponsesToolChoice(
        options.toolChoice,
        converted.projection,
      );
      if (toolChoice !== undefined) {
        params.tool_choice = toolChoice;
      }
    }
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
      const requestedReasoningEffort = resolveOpenAIReasoningEffort(options);
      const resolvedReasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: requestedReasoningEffort,
      });
      const reasoningEffort = resolvedReasoningEffort
        ? raiseMinimalReasoningForResponsesWebSearch({
            model,
            effort: resolvedReasoningEffort,
            tools: params.tools,
          })
        : undefined;
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
          ...(reasoningEffort === "none" ? {} : { summary: options?.reasoningSummary || "auto" }),
        };
        if (reasoningEffort !== "none") {
          params.include = ["reasoning.encrypted_content"];
        }
      }
    } else if (model.provider !== "github-copilot") {
      const reasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: "none",
      });
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
        };
      }
    }
  }
  applyOpenAIResponsesPayloadPolicy(params as Record<string, unknown>, payloadPolicy);
  return sanitizeOpenAICodexResponsesParams(
    model,
    params as Record<string, unknown>,
  ) as typeof params;
}
