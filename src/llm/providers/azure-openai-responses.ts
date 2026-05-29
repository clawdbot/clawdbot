import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../model-utils.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { resolveAzureDeploymentNameFromMap } from "./azure-deployment-map.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
  "azure-openai-responses",
]);

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
export interface AzureOpenAIResponsesOptions extends StreamOptions {
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

  // Start async processing
  void (async () => {
    const deploymentName = resolveDeploymentName(model, options);

    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "azure-openai-responses" as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      // Create Azure OpenAI client
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const client = createClient(model, apiKey, options);
      let params = buildParams(model, context, options, deploymentName);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as ResponseCreateParamsStreaming;
      }
      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      };
      const { data: openaiStream, response } = await client.responses
        .create(params, requestOptions)
        .withResponse();
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      stream.push({ type: "start", partial: output });

      await processResponsesStream(openaiStream, output, stream, model);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatAzureOpenAIError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

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
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoningEffort =
    clampedReasoning === "off"
      ? undefined
      : clampedReasoning === "max"
        ? "xhigh"
        : clampedReasoning;

  return streamAzureOpenAIResponses(model, context, {
    ...base,
    reasoningEffort,
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
  apiKey: string,
  options?: AzureOpenAIResponsesOptions,
) {
  if (!apiKey) {
    if (!process.env.AZURE_OPENAI_API_KEY) {
      throw new Error(
        "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
      );
    }
    apiKey = process.env.AZURE_OPENAI_API_KEY;
  }

  const headers = { ...model.headers };

  if (options?.headers) {
    Object.assign(headers, options.headers);
  }

  const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

  return new AzureOpenAI({
    apiKey,
    apiVersion,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
    baseURL: baseUrl,
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
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options?.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertResponsesTools(context.tools, { model });
  }

  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      const effort = options?.reasoningEffort
        ? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
        : "medium";
      params.reasoning = {
        effort: effort as NonNullable<typeof params.reasoning>["effort"],
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.thinkingLevelMap?.off !== null) {
      params.reasoning = {
        effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
          typeof params.reasoning
        >["effort"],
      };
    }
  }

  return params;
}
