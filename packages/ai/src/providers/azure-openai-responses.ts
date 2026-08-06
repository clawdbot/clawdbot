// Azure OpenAI Responses provider adapts Azure deployments to Responses API streams.
import OpenAI, { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import type {
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { resolveAzureDeploymentNameFromMap } from "./azure-deployment-map.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "./azure-openai-responses-client-compat.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import {
  applyCommonResponsesParams,
  convertResponsesMessages,
  createResponsesAssistantOutput,
  resolveResponsesReasoningEffort,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode", "azure-openai-responses"]);

function resolveDeploymentName(
  model: Model<"azure-openai-responses">,
  options?: AzureOpenAIResponsesOptions,
): string {
  if (options?.azureDeploymentName) {
    return options.azureDeploymentName;
  }
  return resolveAzureDeploymentNameFromMap({
    modelId: model.id,
    deploymentMap: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP,
  });
}

function formatAzureOpenAIError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as Error & { status?: unknown }).status;
    const statusCode = typeof status === "number" ? status : undefined;
    if (statusCode !== undefined) {
      return `Azure OpenAI API error (${statusCode}): ${error.message}`;
    }
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Azure OpenAI Responses-specific options
interface AzureOpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  azureApiVersion?: string;
  azureResourceName?: string;
  azureBaseUrl?: string;
  azureDeploymentName?: string;
}

/**
 * Generate function for Azure OpenAI Responses API
 */
export const streamAzureOpenAIResponses: StreamFunction<
  "azure-openai-responses",
  AzureOpenAIResponsesOptions
> = (
  model: Model<"azure-openai-responses">,
  context: Context,
  options?: AzureOpenAIResponsesOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createResponsesAssistantOutput(model, "azure-openai-responses");

  // Start async processing
  void runResponsesStreamLifecycle({
    stream,
    model,
    output,
    options,
    createClient: () => {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      return createClient(model, apiKey, options);
    },
    buildParams: () => buildParams(model, context, options, resolveDeploymentName(model, options)),
    formatError: formatAzureOpenAIError,
  });

  return stream;
};

export const streamSimpleAzureOpenAIResponses: StreamFunction<
  "azure-openai-responses",
  SimpleStreamOptions
> = (model: Model<"azure-openai-responses">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = resolveResponsesReasoningEffort(model, options?.reasoning);

  return streamAzureOpenAIResponses(model, context, {
    ...base,
    reasoningEffort: reasoningEffort === "max" ? "xhigh" : reasoningEffort,
  } satisfies AzureOpenAIResponsesOptions);
};

function normalizeAzureBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
  }

  const isAzureHost =
    url.hostname.endsWith(".openai.azure.com") ||
    url.hostname.endsWith(".cognitiveservices.azure.com");
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  // Ensure Azure hosts have /openai/v1 as base path so the AzureOpenAI SDK
  // can append /deployments/<model>/... and ?api-version=v1 correctly.
  if (
    isAzureHost &&
    (normalizedPath === "" || normalizedPath === "/" || normalizedPath === "/openai")
  ) {
    url.pathname = "/openai/v1";
    url.search = "";
  }

  return url.toString().replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
  return `https://${resourceName}.openai.azure.com/openai/v1`;
}

function resolveAzureConfig(
  model: Model<"azure-openai-responses">,
  options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
  const apiVersion =
    options?.azureApiVersion || process.env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

  const baseUrl =
    options?.azureBaseUrl?.trim() || process.env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
  const resourceName = options?.azureResourceName || process.env.AZURE_OPENAI_RESOURCE_NAME;

  let resolvedBaseUrl = baseUrl;

  if (!resolvedBaseUrl && resourceName) {
    resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
  }

  if (!resolvedBaseUrl && model.baseUrl) {
    resolvedBaseUrl = model.baseUrl;
  }

  if (!resolvedBaseUrl) {
    throw new Error(
      "Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
    );
  }

  return {
    baseUrl: normalizeAzureBaseUrl(resolvedBaseUrl),
    apiVersion,
  };
}

function createClient(
  model: Model<"azure-openai-responses">,
  apiKeyInput: string,
  options?: AzureOpenAIResponsesOptions,
) {
  const apiKey = apiKeyInput.trim();
  if (!apiKey) {
    throw new Error(
      "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
    );
  }

  const headers = { ...model.headers };

  if (options?.headers) {
    Object.assign(headers, options.headers);
  }

  const { baseUrl, apiVersion } = resolveAzureConfig(model, options);
  // Both OpenAI clients support custom fetch, so sentinels stay opaque until guarded egress.
  const guardedFetch = getAiTransportHost().buildModelFetch({ ...model, baseUrl });

  if (isOpenAICompatibleAzureResponsesBaseUrl(baseUrl)) {
    return new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true,
      defaultHeaders: headers,
      baseURL: baseUrl,
      fetch: guardedFetch,
    });
  }

  return new AzureOpenAI({
    apiKey,
    apiVersion,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
    baseURL: baseUrl,
    fetch: guardedFetch,
  });
}

function buildParams(
  model: Model<"azure-openai-responses">,
  context: Context,
  options: AzureOpenAIResponsesOptions | undefined,
  deploymentName: string,
) {
  const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS);

  const params: ResponseCreateParamsStreaming = {
    model: deploymentName,
    input: messages,
    stream: true,
    prompt_cache_key:
      options?.cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
    store: false,
  };

  applyCommonResponsesParams(params, model, context, options);

  return params;
}

export const testing = {
  isOpenAICompatibleAzureResponsesBaseUrl,
  normalizeAzureBaseUrl,
  resolveAzureConfig,
};
