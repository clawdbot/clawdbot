// OpenAI Responses provider adapts OpenAI response streams to the agent runtime.
import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import type { OpenAIResponsesReplayMode } from "../transports/openai-responses-compaction-replay.js";
import type { OpenAIResponsesRequestParams } from "../transports/openai-responses-contracts.js";
import { resolveOpenAIClientBaseUrl } from "../transports/openai-transport-shared.js";
import type {
  Context,
  Model,
  OpenAIResponsesCompat,
  SimpleStreamOptions,
  StreamFunction,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import {
  clampOpenAIPromptCacheKey,
  resolveOpenAIResponsesCacheParams,
} from "./openai-prompt-cache.js";
import { supportsOpenAITemperature } from "./openai-reasoning-effort.js";
import {
  applyCommonResponsesParams,
  applyResponsesServiceTierPricing,
  convertResponsesMessages,
  createResponsesAssistantOutput,
  resolveResponsesReasoningEffort,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);

type ResolvedOpenAIResponsesCompat = Required<
  Pick<OpenAIResponsesCompat, "sendSessionIdHeader" | "supportsLongCacheRetention">
>;

function getCompat(model: Model<"openai-responses">): ResolvedOpenAIResponsesCompat {
  return {
    sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
  };
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends BaseOpenAIStreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

type OpenAIResponsesReplayOptions = SimpleStreamOptions & {
  authProfileId?: string;
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
    buildParams: (_requestModel, replayMode) => buildParams(model, context, options, replayMode),
    processStreamOptions: {
      serviceTier: options?.serviceTier,
      applyServiceTierPricing: (usage, serviceTier) =>
        applyResponsesServiceTierPricing(usage, serviceTier, model),
    },
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
  const replayOptions = options as OpenAIResponsesReplayOptions | undefined;

  return streamOpenAIResponses(model, context, {
    ...base,
    authProfileId: replayOptions?.authProfileId,
    reasoningEffort: resolveResponsesReasoningEffort(model, options?.reasoning),
    replayResponsesItemIds: replayOptions?.replayResponsesItemIds,
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

  const baseUrl = isCloudflareProvider(model.provider)
    ? resolveCloudflareBaseUrl(model)
    : model.baseUrl;
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIClientBaseUrl(model, baseUrl),
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    maxRetries: 0,
    // OpenAI supports custom fetch, so sentinels stay opaque until guarded egress.
    fetch: getAiTransportHost().buildModelFetch(model),
  });
}

function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
  replayMode: OpenAIResponsesReplayMode = "checkpoint",
) {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    replayResponsesItemIds: options?.replayResponsesItemIds ?? false,
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    replayMode,
  });

  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const compat = getCompat(model);
  const params: ResponseCreateParamsStreaming & OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key:
      cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
    ...resolveOpenAIResponsesCacheParams(model, cacheRetention, compat.supportsLongCacheRetention),
    store: false,
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options?.maxTokens;
  }

  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
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
