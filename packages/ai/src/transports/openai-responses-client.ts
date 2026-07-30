import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI, { AzureOpenAI } from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { resolveAzureDeploymentNameFromMap } from "../providers/azure-deployment-map.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "../providers/azure-openai-responses-client-compat.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import { formatModelTransportDebugBaseUrl } from "./model-transport-url.js";
import {
  AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
  type OpenAIResponsesOptions,
} from "./openai-responses-contracts.js";
import {
  applyServiceTierPricing,
  logResponsesFailedNoDetails,
  safeDebugValue,
  summarizeOpenAITransportError,
  summarizeResponsesPayload,
} from "./openai-responses-debug.js";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  createResponsesStreamWithEncryptedContentRetry,
  resolveAzureOpenAIApiVersion,
} from "./openai-responses-replay-internal.js";
import {
  processResponsesStream,
  ResponsesStreamFailure,
} from "./openai-responses-stream-internal.js";
import { observeResponsesStream } from "./openai-responses-stream-observer-internal.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  isOpenAICodexResponsesModel,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";
import { log } from "./openai-transport-shared.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";
import {
  assignTransportErrorDetails,
  mergeTransportMetadata,
  transportAbortError,
} from "./transport-stream-shared.js";

function resolveProviderTransportTurnState(
  model: Model,
  params: {
    sessionId?: string;
    turnId: string;
    attempt: number;
    transport: "stream" | "websocket";
  },
) {
  const normalizedProvider = model.provider.trim().toLowerCase();
  const allowRuntimePluginLoad =
    normalizedProvider === "openai" ||
    normalizedProvider === "azure-openai" ||
    normalizedProvider === "azure-openai-responses";
  return getAiTransportHost().plugin.resolveTransportTurnState({
    provider: model.provider,
    modelId: model.id,
    allowRuntimePluginLoad,
    context: {
      provider: model.provider,
      modelId: model.id,
      model,
      sessionId: params.sessionId,
      turnId: params.turnId,
      attempt: params.attempt,
      transport: params.transport,
    },
  });
}

export function createOpenAIResponsesClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
  sessionId?: string,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders, sessionId),
    fetch: buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

type ResponsesPricingOptions = Pick<
  NonNullable<Parameters<typeof processResponsesStream>[4]>,
  "serviceTier" | "applyServiceTierPricing"
>;
type ResponsesStreamParams = Parameters<
  typeof createResponsesStreamWithEncryptedContentRetry
>[0] & {
  requestOptions: ReturnType<typeof buildOpenAISdkRequestOptions>;
};

type ResponsesTransportExecutorOptions = {
  outputApi?: AssistantMessage["api"];
  firstEventTimeoutMs?: number;
  streamRequest?: boolean;
  createClient: typeof createOpenAIResponsesClient;
  buildRequest: (
    model: Model,
    context: Context,
    options: OpenAIResponsesOptions | undefined,
    metadata?: Record<string, string>,
  ) => ReturnType<typeof buildOpenAIResponsesParams>;
  createResponseStream: (params: ResponsesStreamParams) => Promise<AsyncIterable<unknown>>;
  pricingOptions?: (options: OpenAIResponsesOptions | undefined) => ResponsesPricingOptions;
};

function createResponsesTransportExecutor(config: ResponsesTransportExecutorOptions): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: AssistantMessage = {
        role: "assistant" as const,
        content: [],
        api: config.outputApi ?? model.api,
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
      let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const client = config.createClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
          options?.sessionId,
        );
        let params = config.buildRequest(model, context, responsesOptions, turnState?.metadata);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (!isOpenAICodexResponsesModel(model)) {
          params = mergeTransportMetadata(params, turnState?.metadata);
        }
        params = sanitizeOpenAICodexResponsesParams(
          model,
          params as Record<string, unknown>,
        ) as typeof params;
        params = sanitizeResponsesImagePayload(params as Record<string, unknown>) as typeof params;
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          const visibleToolNames = resolveCodeModeResponsesVisibleToolNames(context);
          enforceCodeModeResponsesToolSurface(params, visibleToolNames);
          assertCodeModeResponsesToolSurface(params, visibleToolNames);
        }
        const requestStartedAt = Date.now();
        firstEventAbort = createFirstStreamEventAbortController(options?.signal);
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEventAbort.signal, {
          stream: config.streamRequest,
          timeoutMs: options?.timeoutMs,
          maxRetries: options?.maxRetries,
        });
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseStream = await config.createResponseStream({
          client,
          request: params,
          requestOptions,
          model,
        });
        emitModelTransportDebug(
          log,
          `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - requestStartedAt}`,
        );
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(
          observeResponsesStream(responseStream, model),
          output,
          stream,
          model,
          {
            ...config.pricingOptions?.(responsesOptions),
            firstEventTimeoutMs:
              getFirstStreamEventTimeoutMs(options) ?? config.firstEventTimeoutMs,
            abortFirstEventStream: firstEventAbort.abort,
            onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
            signal: options?.signal,
            reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: responsesOptions?.authProfileId,
              sessionId: options?.sessionId,
            }),
          },
        );
        if (options?.signal?.aborted) {
          throw transportAbortError(options.signal);
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        if (error instanceof ResponsesStreamFailure && error.observation) {
          logResponsesFailedNoDetails(error.observation);
        }
        log.warn(
          `[responses] error provider=${model.provider} api=${model.api} model=${model.id} ` +
            summarizeOpenAITransportError(error),
        );
        assignTransportErrorDetails(output, error, options?.signal);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      } finally {
        firstEventAbort?.dispose();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return createResponsesTransportExecutor({
    streamRequest: true,
    createClient: createOpenAIResponsesClient,
    buildRequest: buildOpenAIResponsesParams,
    createResponseStream: createResponsesStreamWithEncryptedContentRetry,
    pricingOptions: (options) => ({ serviceTier: options?.serviceTier, applyServiceTierPricing }),
  });
}

export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return createResponsesTransportExecutor({
    outputApi: "azure-openai-responses",
    firstEventTimeoutMs: AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
    createClient: createAzureOpenAIClient,
    buildRequest: (model, context, options, metadata) =>
      buildAzureOpenAIResponsesParams(
        model,
        context,
        options,
        resolveAzureDeploymentName(model),
        metadata,
      ),
    createResponseStream: async ({ client, request, requestOptions }) =>
      (await client.responses.create(
        request as never,
        requestOptions,
      )) as unknown as AsyncIterable<unknown>,
  });
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveAzureDeploymentName(model: Model): string {
  return resolveAzureDeploymentNameFromMap({
    modelId: model.id,
    deploymentMap: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP,
  });
}

export function createAzureOpenAIClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  const baseURL = normalizeAzureBaseUrl(model.baseUrl);
  const clientOptions = {
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    baseURL,
    fetch: buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  };

  if (isOpenAICompatibleAzureResponsesBaseUrl(baseURL)) {
    return new OpenAI(clientOptions);
  }

  return new AzureOpenAI({
    ...clientOptions,
    apiVersion: resolveAzureOpenAIApiVersion(),
  });
}

function buildAzureOpenAIResponsesParams(
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  deploymentName: string,
  metadata?: Record<string, string>,
) {
  const params = buildOpenAIResponsesParams(model, context, options, metadata);
  params.model = deploymentName;
  delete params.store;
  return params;
}
