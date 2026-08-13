import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI, { AzureOpenAI } from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { resolveAzureDeploymentNameFromMap } from "../providers/azure-deployment-map.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "../providers/azure-openai-responses-client-compat.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { projectProviderError } from "../utils/provider-error.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import { formatModelTransportDebugBaseUrl } from "./model-transport-url.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import {
  claimOpenAIResponsesHttpContinuation,
  type ResponsesContinuationRequest,
} from "./openai-responses-continuation.js";
import {
  AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
  OpenAIResponsesWebSocketPreDispatchError,
  OpenAIResponsesWebSocketSafeRetryError,
  type OpenAIResponsesOptions,
} from "./openai-responses-contracts.js";
import {
  applyServiceTierPricing,
  logResponsesFailedNoDetails,
  ResponsesStreamFailure,
  safeDebugValue,
  summarizeOpenAITransportError,
  summarizeResponsesPayload,
} from "./openai-responses-debug.js";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";
import { createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal.js";
import {
  createResponsesStreamWithEncryptedContentRetry,
  resolveAzureOpenAIApiVersion,
} from "./openai-responses-replay-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import { observeResponsesStream } from "./openai-responses-stream-observer-internal.js";
import {
  createOpenAIResponsesWebSocketStream,
  type OpenAIResponsesWebSocketMode,
  supportsNativeOpenAIResponsesEndpoint,
} from "./openai-responses-websocket.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  isOpenAICodexResponsesModel,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";
import { createOpenAIResponseHook, log } from "./openai-transport-shared.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";
import {
  mergeTransportMetadata,
  transportAbortError,
  withProviderResponseHook,
} from "./transport-stream-shared.js";
import { redactIdentifier } from "./transport-utils.js";

function resolveNativeOpenAIResponsesWebSocketMode(
  model: Model,
  transport: OpenAIResponsesOptions["transport"],
): OpenAIResponsesWebSocketMode | undefined {
  if (transport !== "websocket" && transport !== "websocket-cached" && transport !== "auto") {
    return undefined;
  }
  if (getAiTransportHost().requiresManagedTransport(model)) {
    return undefined;
  }
  return supportsNativeOpenAIResponsesEndpoint({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
  })
    ? transport
    : undefined;
}

function combineWebSocketTimeoutSignal(
  signal: AbortSignal,
  model: Model,
  timeoutMs: number | undefined,
) {
  const resolvedTimeoutMs =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : getAiTransportHost().resolveModelRequestTimeoutMs(model);
  if (resolvedTimeoutMs === undefined || !Number.isFinite(resolvedTimeoutMs)) {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, resolvedTimeoutMs))]);
}

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
  httpContinuation?: boolean;
  createClient: typeof createOpenAIResponsesClient;
  buildRequest: (
    model: Model,
    context: Context,
    options: OpenAIResponsesOptions | undefined,
    metadata?: Record<string, string>,
    replayMode?: OpenAIResponsesReplayMode,
  ) => ReturnType<typeof buildOpenAIResponsesParams>;
  createResponseStream: (
    params: ResponsesStreamParams,
  ) => ReturnType<typeof createResponsesStreamWithEncryptedContentRetry>;
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
      let continuationClaim: ReturnType<typeof claimOpenAIResponsesHttpContinuation>;
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const websocketMode = resolveNativeOpenAIResponsesWebSocketMode(
          model,
          responsesOptions?.transport,
        );
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: websocketMode ? "websocket" : "stream",
        });
        const websocketSessionPolicy = websocketMode ? turnState?.websocket : undefined;
        const websocketHeaders = websocketMode
          ? buildOpenAIClientHeaders(
              model,
              context,
              options?.headers,
              websocketSessionPolicy?.headers,
              options?.sessionId,
            )
          : undefined;
        const client = config.createClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
          options?.sessionId,
        );
        const buildRequest = async (replayMode: OpenAIResponsesReplayMode) => {
          let params = config.buildRequest(
            model,
            context,
            responsesOptions,
            turnState?.metadata,
            replayMode,
          );
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
          params = sanitizeResponsesImagePayload(
            params as Record<string, unknown>,
          ) as typeof params;
          if (
            (options as { openclawCodeModeToolSurface?: unknown } | undefined)
              ?.openclawCodeModeToolSurface === true
          ) {
            const visibleToolNames = resolveCodeModeResponsesVisibleToolNames(context);
            const allowedHostedToolTypes = responsesOptions?.openclawCodeModeAllowedHostedToolTypes;
            enforceCodeModeResponsesToolSurface(params, visibleToolNames, allowedHostedToolTypes);
            assertCodeModeResponsesToolSurface(params, visibleToolNames, allowedHostedToolTypes);
          }
          return params;
        };
        const params = await buildRequest("checkpoint");
        const sessionId = options?.sessionId;
        const httpContinuationEligible =
          config.httpContinuation &&
          !websocketMode &&
          !getAiTransportHost().requiresManagedTransport(model) &&
          supportsNativeOpenAIResponsesEndpoint({
            provider: model.provider,
            api: model.api,
            baseUrl: model.baseUrl,
          });
        if (
          httpContinuationEligible &&
          sessionId &&
          params.store === true &&
          !params.previous_response_id
        ) {
          continuationClaim = claimOpenAIResponsesHttpContinuation({
            sessionId,
            apiKey,
            baseUrl: model.baseUrl,
            headers: buildOpenAIClientHeaders(
              model,
              context,
              options?.headers,
              turnState?.headers,
              sessionId,
            ),
            request: params as ResponsesContinuationRequest,
          });
        }
        const observePrompt = createResponsesPromptEgressObserver(
          responsesOptions,
          context.systemPrompt,
        );
        const requestStartedAt = Date.now();
        let started = false;
        const startStream = () => {
          if (!started) {
            started = true;
            stream.push({ type: "start", partial: output as never });
          }
        };
        const firstEvent = createFirstStreamEventAbortController(options?.signal);
        firstEventAbort = firstEvent;
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEvent.signal, {
          stream: config.streamRequest,
          timeoutMs: options?.timeoutMs,
          maxRetries: options?.maxRetries,
        });
        const websocketSignal = combineWebSocketTimeoutSignal(
          firstEvent.signal,
          model,
          requestOptions?.timeout,
        );
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `requestIdHash=${redactIdentifier(options?.requestId, { len: 64 })} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        let continuationBaseline: ResponsesContinuationRequest | undefined;
        const createSseStream = async (
          initialRequest = (continuationClaim?.request ?? params) as typeof params,
          initialAttemptKind: "initial" | "continuation-rejected" = "initial",
        ): Promise<AsyncIterable<unknown>> => {
          const {
            stream: rawResponseStream,
            response,
            attempt,
          } = await config.createResponseStream({
            client,
            request: initialRequest,
            requestOptions,
            model,
            observePrompt,
            initialAttemptKind,
            buildFullHistoryRequest: () => buildRequest("full-history"),
            onCompactionRejected: () =>
              suppressOpenAIResponsesCompaction(output, model, {
                sessionId: options?.sessionId,
                authProfileId: responsesOptions?.authProfileId,
              }),
          });
          if (continuationClaim) {
            continuationBaseline = attempt.request.previous_response_id
              ? (params as ResponsesContinuationRequest)
              : (attempt.request as ResponsesContinuationRequest);
          }
          return withProviderResponseHook({
            stream: observeResponsesStream(rawResponseStream, model, requestStartedAt),
            signal: firstEvent.signal,
            abort: firstEvent.abort,
            hook: createOpenAIResponseHook(options?.onResponse, response, model),
            onReady: () => {
              emitModelTransportDebug(
                log,
                `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
                  `transport=sse elapsedMs=${Date.now() - requestStartedAt}`,
              );
              startStream();
            },
          });
        };

        let responseStream: AsyncIterable<unknown>;
        let finishWebSocket: ((options?: { keep?: boolean }) => void) | undefined;
        let transport: "sse" | "websocket" = "sse";
        const logWebSocketFallback = (reason: string) =>
          emitModelTransportDebug(
            log,
            `[responses] websocket_fallback provider=${model.provider} api=${model.api} ` +
              `model=${model.id} reason=${reason}`,
          );
        if (websocketMode) {
          try {
            const websocket = createOpenAIResponsesWebSocketStream({
              client,
              request: params,
              mode: websocketMode,
              sessionId: options?.sessionId,
              headers: websocketHeaders,
              signal: websocketSignal,
              callerSignal: options?.signal,
              degradeCooldownMs: websocketSessionPolicy?.degradeCooldownMs,
            });
            finishWebSocket = websocket.finish;
            observePrompt?.(websocket.request, {
              egress: "responses-websocket",
              payloadVariant: "initial",
            });
            transport = "websocket";
            emitModelTransportDebug(
              log,
              `[responses] websocket_selected provider=${model.provider} api=${model.api} model=${model.id} ` +
                `mode=${websocketMode} reused=${websocket.reusedConnection} ` +
                `continuation=${websocket.continuationStatus === "continued"} continuationStatus=${websocket.continuationStatus} ` +
                `sessionIdHash=${redactIdentifier(options?.sessionId)} ` +
                `headersHash=${redactIdentifier(JSON.stringify(Object.entries(websocketHeaders ?? {}).toSorted(([a], [b]) => a.localeCompare(b))))}`,
            );
            responseStream = {
              async *[Symbol.asyncIterator]() {
                try {
                  for await (const event of websocket.stream) {
                    startStream();
                    yield event;
                  }
                } catch (error) {
                  if (error instanceof OpenAIResponsesWebSocketSafeRetryError) {
                    finishWebSocket?.({ keep: false });
                    finishWebSocket = undefined;
                    transport = "sse";
                    logWebSocketFallback(
                      `safe_server_error code=${error.code} status=${safeDebugValue(error.status)} param=${safeDebugValue(error.param)}`,
                    );
                    yield* await createSseStream(
                      await buildRequest("full-history"),
                      "continuation-rejected",
                    );
                    return;
                  }
                  if (
                    websocketSignal.aborted ||
                    !(error instanceof OpenAIResponsesWebSocketPreDispatchError)
                  ) {
                    throw error;
                  }
                  transport = "sse";
                  logWebSocketFallback("before_first_event");
                  yield* await createSseStream();
                }
              },
            };
          } catch {
            finishWebSocket?.({ keep: false });
            finishWebSocket = undefined;
            logWebSocketFallback("setup_failure");
            responseStream = await createSseStream();
          }
        } else {
          responseStream = await createSseStream();
        }
        try {
          const terminal = await processResponsesStream(responseStream, output, stream, model, {
            ...config.pricingOptions?.(responsesOptions),
            firstEventTimeoutMs:
              getFirstStreamEventTimeoutMs(options) ?? config.firstEventTimeoutMs,
            abortFirstEventStream: firstEvent.abort,
            onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
            signal: options?.signal,
            reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: responsesOptions?.authProfileId,
              sessionId: options?.sessionId,
            }),
          });
          finishWebSocket?.();
          if (options?.signal?.aborted) {
            throw transportAbortError(options.signal);
          }
          if (output.stopReason === "aborted" || output.stopReason === "error") {
            throw new Error("An unknown error occurred");
          }
          if (continuationClaim && continuationBaseline && terminal) {
            continuationClaim.commit(continuationBaseline, terminal);
          }
        } catch (error) {
          finishWebSocket?.({ keep: false });
          throw error;
        }
        emitModelTransportDebug(
          log,
          `[responses] completed provider=${model.provider} api=${model.api} model=${model.id} ` +
            `transport=${transport} elapsedMs=${Date.now() - requestStartedAt}`,
        );
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
        Object.assign(output, projectProviderError(error, options?.signal));
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      } finally {
        continuationClaim?.release();
        firstEventAbort?.dispose();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return createResponsesTransportExecutor({
    streamRequest: true,
    httpContinuation: true,
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
    buildRequest: (model, context, options, metadata, replayMode) =>
      buildAzureOpenAIResponsesParams(
        model,
        context,
        options,
        resolveAzureDeploymentName(model),
        metadata,
        replayMode,
      ),
    createResponseStream: createResponsesStreamWithEncryptedContentRetry,
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
  replayMode: OpenAIResponsesReplayMode = "checkpoint",
) {
  const params = buildOpenAIResponsesParams(model, context, options, metadata, replayMode);
  params.model = deploymentName;
  delete params.store;
  return params;
}
