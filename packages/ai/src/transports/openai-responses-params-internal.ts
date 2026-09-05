import type { Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  FunctionTool,
  ResponseFormatTextConfig,
  ResponseInput,
} from "openai/resources/responses/responses.js";
import { resolveCacheRetention } from "../providers/cache-retention.js";
import { resolveOpenAIResponsesCacheParams } from "../providers/openai-prompt-cache.js";
import {
  normalizeOpenAIReasoningEffort,
  resolveOpenAIReasoningEffortForModel,
  supportsOpenAITemperature,
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

function buildOpenAIResponsesInstructionsText(context: Context): string | undefined {
  if (!context.systemPrompt) {
    return undefined;
  }
  return sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt));
}

// A Responses-API request whose route honors `instructions` carries the
// system prompt there, never as an `input` message: `input` is what HTTP
// continuation (openai-responses-continuation.ts) compares byte-for-byte
// against the cached previous request to decide whether it can reuse
// previous_response_id. The embedded runner rebuilds the system prompt fresh
// on every attempt from live runtime state (active background processes,
// watched sessions, active-memory context) -- if that text sat inside
// `input`, ordinary state churn between two turns would make the comparison
// fail and permanently defeat continuation. `instructions` sits outside the
// compared `input` array, so it can vary freely per turn with no effect on
// continuation eligibility. Routes that opt out via `compat.supportsInstructions:
// false` (see openai-responses-payload-policy.ts) get no instructions field at
// all -- convertOpenAIResponsesMessagesForRequest embeds the prompt back into
// `input` for those instead.
function resolveOpenAIResponsesInstructions(
  model: Model,
  context: Context,
  usesInstructionsField: boolean,
): string | undefined {
  if (!usesInstructionsField) {
    return undefined;
  }
  const instructions = buildOpenAIResponsesInstructionsText(context);
  if (instructions && instructions.trim().length > 0) {
    return instructions;
  }
  return usesNativeOpenAICodexResponsesBackend(model)
    ? OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS
    : undefined;
}

// xAI's server-side `/responses/compact` endpoint (see
// postOpenAIResponsesCompaction in openai-responses-client.ts) predates and
// does not accept `instructions`: per
// https://docs.x.ai/developers/advanced-api-usage/context-compaction the
// system prompt must be the first `input` message, unlike the main streaming
// endpoint. Build that message on demand so the compact request body can
// re-embed the same text the streaming path now carries via `instructions`.
export function buildOpenAIResponsesCompactSystemMessage(model: Model, instructions: string) {
  // SAFETY: only reached from postOpenAIResponsesCompaction (Responses-API compact endpoint), so model is always OpenAI-mode here.
  const compat = getCompat(model as OpenAIModeModel);
  const supportsDeveloperRole =
    typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
  const role = model.reasoning && supportsDeveloperRole !== false ? "developer" : "system";
  return buildResponsesInputMessage(role, [{ type: "input_text", text: instructions }]);
}

// The Responses API rejects an empty `input` array; when the only content
// for this turn was the system prompt (now carried by `instructions`
// instead), inject a placeholder input item so the request stays valid.
function ensureOpenAIResponsesNonEmptyInput(messages: ResponseInput, context: Context): void {
  if (messages.length > 0 || !context.systemPrompt) {
    return;
  }
  const text = buildOpenAIResponsesInstructionsText(context);
  if (!text) {
    throw new Error(
      "OpenAI Responses requires non-empty input when only systemPrompt is provided.",
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
  const isNativeCodexResponses = usesNativeOpenAICodexResponsesBackend(model);
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const policyAllowsReplayIds =
    payloadPolicy.explicitStore !== false && !payloadPolicy.shouldStripStore;
  const replayResponsesItemIds =
    !isNativeCodexResponses && (options?.replayResponsesItemIds ?? policyAllowsReplayIds);
  return convertResponsesMessages(model, context, OPENAI_RESPONSES_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: !payloadPolicy.usesInstructionsField,
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
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const messages = convertOpenAIResponsesMessagesForRequest(model, context, options, replayMode);
  ensureOpenAIResponsesNonEmptyInput(messages, context);
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const instructions = resolveOpenAIResponsesInstructions(
    model,
    context,
    payloadPolicy.usesInstructionsField,
  );
  const params: OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: promptCacheKey,
    ...resolveOpenAIResponsesCacheParams(
      model,
      cacheRetention,
      model.baseUrl?.includes("api.openai.com"),
    ),
    ...(instructions ? { instructions } : {}),
    ...(metadata ? { metadata } : {}),
  };
  const effectiveMaxTokens = options?.maxTokens || model.maxTokens;
  if (effectiveMaxTokens) {
    // Responses rejects output budgets below 16 tokens.
    params.max_output_tokens = Math.max(effectiveMaxTokens, 16);
  }
  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
    params.temperature = options.temperature;
  }
  // Astra rejects top_p independently of the temperature compatibility setting.
  if (options?.topP !== undefined && model.id !== "gpt-6-astra") {
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
