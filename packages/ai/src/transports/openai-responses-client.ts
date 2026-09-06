import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI, { AzureOpenAI } from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { codeModeToolSurfaceObserver } from "../provider-options.js";
import { resolveAzureDeploymentNameFromMap } from "../providers/azure-deployment-map.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "../providers/azure-openai-responses-client-compat.js";
import { applyResponsesServiceTierPricing } from "../providers/openai-responses-shared.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { emitModelTransportDebug } from "./model-transport-debug.js";
import { formatModelTransportDebugBaseUrl } from "./model-transport-url.js";
import { postOpenAIResponsesCompaction } from "./openai-responses-compact-client.js";
import { claimResponsesCompactRequest } from "./openai-responses-compact-request.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import { createBoundedOpenAIResponsesCompactionFetch } from "./openai-responses-compaction-window.js";
import {
  claimOpenAIResponsesHttpContinuation,
  type ResponsesContinuationRequest,
} from "./openai-responses-continuation.js";
import {
  AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
  OpenAIResponsesWebSocketPreDispatchError,
  OpenAIResponsesWebSocketPostDispatchError,
  OpenAIResponsesWebSocketSafeRetryError,
  type OpenAIResponsesOptions,
} from "./openai-responses-contracts.js";
import {
  logResponsesFailedNoDetails,
  ResponsesStreamFailure,
  safeDebugValue,
  summarizeOpenAITransportError,
  summarizeResponsesPayload,
} from "./openai-responses-debug.js";
import { recordResponsesInputReplay } from "./openai-responses-input-replay.js";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";
import { createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal.js";
import { supportsResponsesReasoningUpdate } from "./openai-responses-reasoning-update.js";
import {
  createOpenAIResponsesAssistantOutput,
  createResponsesStreamWithEncryptedContentRetry,
  isInvalidEncryptedContentError,
  resolveNextResponsesEncryptedContentAttempt,
  resolveAzureOpenAIApiVersion,
} from "./openai-responses-replay-internal.js";
import { projectResponsesSteeringInput } from "./openai-responses-steering.js";
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
import {
  createOpenAIProviderAcceptanceHook,
  log,
  resolveOpenAIClientBaseUrl,
} from "./openai-transport-shared.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";
import {
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportMetadata,
  notifyProviderStreamOpened,
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
  fetchOverride?: typeof globalThis.fetch,
) {
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIClientBaseUrl(model),
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders, sessionId),
    fetch: fetchOverride ?? buildGuardedModelFetch(model),
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
  pricingOptions?: (
    options: OpenAIResponsesOptions | undefined,
    model: Model,
  ) => ResponsesPricingOptions;
};

function createResponsesTransportExecutor(config: ResponsesTransportExecutorOptions): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const compactRequest = claimResponsesCompactRequest(responsesOptions);
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output = createOpenAIResponsesAssistantOutput(model, config.outputApi);
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
          compactRequest
            ? createBoundedOpenAIResponsesCompactionFetch(buildGuardedModelFetch(model))
            : undefined,
        );
        const nativeAstra =
          model.id === "gpt-6-astra" && supportsNativeOpenAIResponsesEndpoint(model);
        const asyncToolExecutionEligible =
          nativeAstra &&
          options?.asyncToolExecution === true &&
          !responsesOptions?.openclawCodeModeToolSurface;
        const prepareRequest = async (request: ReturnType<typeof config.buildRequest>) => {
          let params = request;
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
            enforceCodeModeResponsesToolSurface(
              params,
              visibleToolNames,
              allowedHostedToolTypes,
              codeModeToolSurfaceObserver.get(options),
            );
            assertCodeModeResponsesToolSurface(params, visibleToolNames, allowedHostedToolTypes);
          }
          if (
            asyncToolExecutionEligible &&
            params.model === "gpt-6-astra" &&
            params.multi_agent?.enabled !== true &&
            params.tools
          ) {
            params.tools = params.tools.map((tool) =>
              tool.type === "function" ? { ...tool, async: true } : tool,
            );
          }
          return params;
        };
        const buildRequest = (replayMode: OpenAIResponsesReplayMode, requestContext = context) =>
          prepareRequest(
            config.buildRequest(
              model,
              requestContext,
              responsesOptions,
              turnState?.metadata,
              replayMode,
            ),
          );
        let params = await buildRequest("checkpoint");
        const asyncTools =
          asyncToolExecutionEligible &&
          params.model === "gpt-6-astra" &&
          params.multi_agent?.enabled !== true;
        if (compactRequest) {
          const compacted = await postOpenAIResponsesCompaction({
            client,
            model,
            request: params,
            options: responsesOptions,
          });
          output.usage.input = compacted.usage.input_tokens;
          output.usage.output = compacted.usage.output_tokens;
          output.usage.totalTokens = compacted.usage.input_tokens + compacted.usage.output_tokens;
          compactRequest.resolve(compacted);
          finalizeTransportStream({ stream, output, signal: options?.signal });
          return;
        }
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
          (params.store === true || supportsResponsesReasoningUpdate(params)) &&
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
          if (continuationClaim) {
            // SAFETY: The owner preserves the request; SDK inputs predate configuration_update.
            params = continuationClaim.fullRequest as typeof params;
          }
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
            stream.push({ type: "start", partial: output });
          }
        };
        const firstEvent = createFirstStreamEventAbortController(options?.signal);
        firstEventAbort = firstEvent;
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEvent.signal, {
          stream: config.streamRequest,
          timeoutMs: options?.timeoutMs,
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
          initialAttemptKind: NonNullable<ResponsesStreamParams["initialAttemptKind"]> = "initial",
          initialRejectedCompaction?: ResponsesStreamParams["initialRejectedCompaction"],
        ): Promise<AsyncIterable<unknown>> => {
          const { stream: responseStream } = await createResponsesStreamWithEncryptedContentRetry({
            client,
            request: initialRequest,
            requestOptions,
            model,
            observePrompt,
            initialAttemptKind,
            initialRejectedCompaction,
            buildFullHistoryRequest: () => buildRequest("full-history"),
            onCompactionRejected: (checkpoint) =>
              suppressOpenAIResponsesCompaction(output, model, responsesOptions, checkpoint),
            canRetryStream: () => output.content.length === 0,
            wrapStream: ({ stream: rawResponseStream, response, attempt }) => {
              if (continuationClaim) {
                continuationBaseline = attempt.request.previous_response_id
                  ? (params as ResponsesContinuationRequest)
                  : (attempt.request as ResponsesContinuationRequest);
              }
              return withProviderResponseHook({
                stream: observeResponsesStream(rawResponseStream, model, requestStartedAt),
                signal: firstEvent.signal,
                abort: firstEvent.abort,
                hook: createOpenAIProviderAcceptanceHook(options, response, model),
                onReady: () => {
                  emitModelTransportDebug(
                    log,
                    `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
                      `transport=sse elapsedMs=${Date.now() - requestStartedAt}`,
                  );
                  startStream();
                },
              });
            },
          });
          return responseStream;
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
        const closeWebSocketForFallback = (reason: string) => {
          finishWebSocket?.({ keep: false });
          finishWebSocket = undefined;
          transport = "sse";
          logWebSocketFallback(reason);
        };
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
              onActiveResponse:
                nativeAstra && params.model === "gpt-6-astra"
                  ? options?.onActiveResponse
                  : undefined,
              steeringInput: (messages) =>
                projectResponsesSteeringInput(params, () =>
                  buildRequest("checkpoint", {
                    ...context,
                    messages: [...context.messages, ...messages],
                  }),
                ),
            });
            finishWebSocket = websocket.finish;
            recordResponsesInputReplay(output, websocket.inputReplay);
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
                let providerAccepted = false;
                try {
                  for await (const event of websocket.stream) {
                    if (!providerAccepted) {
                      providerAccepted = true;
                      await notifyProviderStreamOpened({
                        options,
                        cancelStream: () => websocket.finish({ keep: false }),
                      });
                    }
                    startStream();
                    yield event;
                  }
                } catch (error) {
                  if (error instanceof OpenAIResponsesWebSocketSafeRetryError) {
                    // Explicit server rejection proves no output was accepted. Resume at the next
                    // semantic attempt instead of treating this like an ambiguous disconnect.
                    const encryptedContentRejected = isInvalidEncryptedContentError(error);
                    const recovery = encryptedContentRejected
                      ? await resolveNextResponsesEncryptedContentAttempt(
                          {
                            kind: "initial",
                            // WebSocket sanitization removes `stream`; SSE must restore it.
                            request: { ...websocket.request, stream: true } as typeof params,
                          },
                          error,
                          { buildFullHistoryRequest: () => buildRequest("full-history") },
                        )
                      : undefined;
                    if (encryptedContentRejected && !recovery) {
                      throw error;
                    }
                    closeWebSocketForFallback(
                      `safe_server_error code=${error.code} status=${safeDebugValue(error.status)} param=${safeDebugValue(error.param)}`,
                    );
                    yield* await createSseStream(
                      recovery?.request ?? (await buildRequest("full-history")),
                      recovery?.kind ?? "continuation-rejected",
                      recovery?.rejectedCompaction,
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
          } catch (error) {
            if (error instanceof OpenAIResponsesWebSocketPostDispatchError) {
              throw error;
            }
            closeWebSocketForFallback("setup_failure");
            responseStream = await createSseStream();
          }
        } else {
          responseStream = await createSseStream();
        }
        try {
          const terminal = await processResponsesStream(responseStream, output, stream, model, {
            ...config.pricingOptions?.(responsesOptions, model),
            firstEventTimeoutMs:
              getFirstStreamEventTimeoutMs(options) ?? config.firstEventTimeoutMs,
            abortFirstEventStream: firstEvent.abort,
            onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
            signal: options?.signal,
            reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: responsesOptions?.authProfileId,
              sessionId: options?.sessionId,
            }),
            asyncToolExecution: asyncTools,
          });
          finishWebSocket?.();
          if (options?.signal?.aborted) {
            throw transportAbortError(options.signal);
          }
          if (output.stopReason === "aborted" || output.stopReason === "error") {
            // Keep the provider's terminal fact; the catch-side projection would overwrite it.
            throw new Error(output.errorMessage ?? "An unknown error occurred");
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
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        if (compactRequest) {
          compactRequest.reject(error);
          failTransportStream({ stream, output, signal: options?.signal, error });
          return;
        }
        if (error instanceof ResponsesStreamFailure && error.observation) {
          logResponsesFailedNoDetails(error.observation);
        }
        log.warn(
          `[responses] error provider=${model.provider} api=${model.api} model=${model.id} ` +
            summarizeOpenAITransportError(error),
        );
        failTransportStream({ stream, output, signal: options?.signal, error });
      } finally {
        continuationClaim?.release();
        firstEventAbort?.dispose();
      }
    })();
    return eventStream;
  };
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return createResponsesTransportExecutor({
    streamRequest: true,
    httpContinuation: true,
    createClient: createOpenAIResponsesClient,
    buildRequest: buildOpenAIResponsesParams,
    pricingOptions: (options, model) => ({
      serviceTier: options?.serviceTier,
      // One canonical service-tier pricing table; a transport-local copy drifted
      // from provider pricing (gpt-5.5 priority 2.5x) and understated costs.
      applyServiceTierPricing: (usage, serviceTier) =>
        applyResponsesServiceTierPricing(usage, serviceTier, model),
    }),
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
  });
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
  _sessionId?: string,
  fetchOverride?: typeof globalThis.fetch,
) {
  const baseURL = model.baseUrl.replace(/\/+$/, "");
  const clientOptions = {
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    baseURL,
    fetch: fetchOverride ?? buildGuardedModelFetch(model),
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
