import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI, { AzureOpenAI } from "openai";
import { getAiTransportHost } from "../host.js";
import {
  isOpenAICompatibleAzureResponsesBaseUrl,
  resolveAzureDeploymentNameFromMap,
} from "../internal/openai.js";
import {
  createFirstStreamEventAbortController,
  getEnvApiKey,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../internal/runtime.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
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

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: AssistantMessage = {
        role: "assistant" as const,
        content: [],
        api: model.api,
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
        const client = createOpenAIResponsesClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
          options?.sessionId,
        );
        let params = buildOpenAIResponsesParams(
          model,
          context,
          responsesOptions,
          turnState?.metadata,
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
        params = sanitizeResponsesImagePayload(params as Record<string, unknown>) as typeof params;
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const requestStartedAt = Date.now();
        firstEventAbort = createFirstStreamEventAbortController(options?.signal);
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEventAbort.signal, {
          stream: true,
        });
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseStream = await createResponsesStreamWithEncryptedContentRetry({
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
            serviceTier: responsesOptions?.serviceTier,
            applyServiceTierPricing,
            firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
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

export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: AssistantMessage = {
        role: "assistant" as const,
        content: [],
        api: "azure-openai-responses",
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
        const client = createAzureOpenAIClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        const deploymentName = resolveAzureDeploymentName(model);
        let params = buildAzureOpenAIResponsesParams(
          model,
          context,
          responsesOptions,
          deploymentName,
          turnState?.metadata,
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
        params = sanitizeResponsesImagePayload(params as Record<string, unknown>) as typeof params;
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const requestStartedAt = Date.now();
        firstEventAbort = createFirstStreamEventAbortController(options?.signal);
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEventAbort.signal);
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseStream = (await client.responses.create(
          params as never,
          requestOptions,
        )) as unknown as AsyncIterable<unknown>;
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
            firstEventTimeoutMs:
              getFirstStreamEventTimeoutMs(options) ?? AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
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
