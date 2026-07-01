// OpenAI Responses provider adapts OpenAI response streams to the agent runtime.
import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import type {
  CacheRetention,
  Context,
  Model,
  OpenAIResponsesCompat,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import {
  applyCommonResponsesParams,
  convertResponsesMessages,
  createResponsesAssistantOutput,
  resolveResponsesReasoningEffort,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
  return {
    sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
  };
}

function getPromptCacheRetention(
  compat: Required<OpenAIResponsesCompat>,
  cacheRetention: CacheRetention,
): "24h" | undefined {
  return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as Error & { status?: unknown }).status;
    const statusCode = typeof status === "number" ? status : undefined;
    if (statusCode !== undefined) {
      return `OpenAI API error (${statusCode}): ${error.message}`;
    }
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

type OpenAIResponsesReplayOptions = SimpleStreamOptions & {
  replayResponsesItemIds?: boolean;
};

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createResponsesAssistantOutput(model);

  // Start async processing
  void runResponsesStreamLifecycle({
    stream,
    model,
    output,
    options,
    createClient: () => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
      return createClient(model, context, apiKey, options?.headers, cacheSessionId);
    },
    buildParams: () => buildParams(model, context, options),
    processStreamOptions: {
      serviceTier: options?.serviceTier,
      applyServiceTierPricing: (usage, serviceTier) =>
        applyServiceTierPricing(usage, serviceTier, model),
    },
    formatError: formatOpenAIResponsesError,
  });

  return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<
  "openai-responses",
  SimpleStreamOptions
> = (model: Model<"openai-responses">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);

  return streamOpenAIResponses(model, context, {
    ...base,
    reasoningEffort: resolveResponsesReasoningEffort(model, options?.reasoning),
    replayResponsesItemIds: (options as OpenAIResponsesReplayOptions | undefined)
      ?.replayResponsesItemIds,
  } satisfies OpenAIResponsesOptions);
};

function createClient(
  model: Model<"openai-responses">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  sessionId?: string,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const compat = getCompat(model);
  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages,
    });
    Object.assign(headers, copilotHeaders);
  }

  if (sessionId) {
    if (compat.sendSessionIdHeader) {
      headers.session_id = sessionId;
    }
    headers["x-client-request-id"] = sessionId;
  }

  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  const defaultHeaders =
    model.provider === "cloudflare-ai-gateway"
      ? {
          ...headers,
          Authorization: headers.Authorization ?? null,
          "cf-aig-authorization": `Bearer ${apiKey}`,
        }
      : headers;

  return new OpenAI({
    apiKey,
    baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
  });
}

function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
) {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    replayResponsesItemIds: options?.replayResponsesItemIds ?? false,
  });

  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const compat = getCompat(model);
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key:
      cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
    prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
    store: false,
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options?.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }

  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }

  applyCommonResponsesParams(params, model, context, options, {
    setDefaultReasoningOff: model.provider !== "github-copilot",
  });

  return params;
}

function getServiceTierCostMultiplier(
  model: Pick<Model<"openai-responses">, "id">,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  model: Pick<Model<"openai-responses">, "id">,
) {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1) {
    return;
  }

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
