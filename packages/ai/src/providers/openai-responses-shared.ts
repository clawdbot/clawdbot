// OpenAI Responses shared helpers map runtime messages, tools, and stream events.
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../model-utils.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
  type OpenAIResponsesReplayMode,
} from "../transports/openai-responses-compaction-replay.js";
import type { OpenAIResponsesRequestParams } from "../transports/openai-responses-contracts.js";
import {
  createOpenAIResponsesAssistantOutput,
  createResponsesStreamWithEncryptedContentRetry,
  convertProviderResponsesMessages,
} from "../transports/openai-responses-replay-internal.js";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import { createOpenAIResponseHook } from "../transports/openai-transport-shared.js";
import {
  transportAbortError,
  withProviderResponseHook,
} from "../transports/transport-stream-shared.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StreamOptions,
  Usage,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { projectProviderError } from "../utils/provider-error.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  type FirstStreamEventInternalOptions,
} from "../utils/stream-first-event-timeout.js";
import {
  resolveOpenAIReasoningEffortForModel,
  supportsOpenAIReasoningEffort,
  supportsOpenAITemperature,
  type OpenAIApiReasoningEffort,
} from "./openai-reasoning-effort.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";

interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
  replayResponsesItemIds?: boolean;
  sessionId?: string;
  authProfileId?: string;
  replayMode?: OpenAIResponsesReplayMode;
}
export { convertResponsesToolPayload };

type ResponsesRequestOptions = {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
};

type ResponsesStreamRequest = {
  withResponse(): Promise<{
    data: AsyncIterable<ResponseStreamEvent>;
    response: Response;
  }>;
};

type ResponsesStreamClient = {
  responses: {
    create(
      params: ResponseCreateParamsStreaming,
      options: ResponsesRequestOptions,
    ): ResponsesStreamRequest;
  };
};

type ResponsesLifecycleStreamOptions = Pick<
  StreamOptions,
  "signal" | "timeoutMs" | "maxRetries" | "onPayload" | "onResponse" | "sessionId"
> &
  Pick<BaseOpenAIStreamOptions, "authProfileId" | "onCompactionRejected"> &
  FirstStreamEventInternalOptions;

type OpenAIResponsesProcessStreamOptions = OpenAIResponsesStreamOptions &
  FirstStreamEventInternalOptions & { signal?: AbortSignal };

type ResponsesReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function isResponsesReasoningEffort(
  effort: string | undefined,
): effort is ResponsesReasoningEffort {
  return (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  );
}
type ResponsesReasoningSummary = "auto" | "detailed" | "concise" | null;

type ResponsesCommonParamsOptions = Pick<StreamOptions, "maxTokens" | "temperature"> & {
  reasoningEffort?: OpenAIApiReasoningEffort;
  reasoningSummary?: ResponsesReasoningSummary;
};

type ResponsesLifecycleRequest = OpenAIResponsesRequestParams;

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  return convertProviderResponsesMessages(model, context, allowedToolCallProviders, options);
}

export const createResponsesAssistantOutput = createOpenAIResponsesAssistantOutput;

// Stream lifecycle
// =============================================================================

export function applyResponsesServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  model: Pick<Model, "id">,
): void {
  let multiplier = 1;
  if (serviceTier === "flex") {
    multiplier = 0.5;
  } else if (serviceTier === "priority") {
    multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
  }
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

function isResponsesReasoningEffortDisabled<TApi extends Api>(model: Model<TApi>): boolean {
  const compat =
    model.api === "openai-responses" && model.compat && typeof model.compat === "object"
      ? model.compat
      : undefined;
  return Boolean(
    compat && "supportsReasoningEffort" in compat && compat.supportsReasoningEffort === false,
  );
}

function isModelThinkingLevel(value: string): value is ModelThinkingLevel {
  return value === "off" || isResponsesReasoningEffort(value);
}

function resolveResponsesApiReasoningEffort<TApi extends Api>(
  model: Model<TApi>,
  reasoning: string,
  fallback = reasoning,
): OpenAIApiReasoningEffort | undefined {
  if (isResponsesReasoningEffortDisabled(model)) {
    return undefined;
  }
  const isCanonicalReasoning = isModelThinkingLevel(reasoning);
  if (isCanonicalReasoning && model.thinkingLevelMap?.[reasoning] === null) {
    return undefined;
  }
  const compat =
    model.api === "openai-responses" && model.compat && typeof model.compat === "object"
      ? model.compat
      : undefined;
  const compatReasoningEffortMap: Record<string, string> | undefined =
    compat && "reasoningEffortMap" in compat ? compat.reasoningEffortMap : undefined;
  const compatMapped = isCanonicalReasoning ? compatReasoningEffortMap?.[reasoning] : undefined;
  if (compatMapped !== undefined) {
    return resolveOpenAIReasoningEffortForModel({
      model,
      effort: reasoning,
      fallbackMap: compatReasoningEffortMap,
    });
  }
  return isCanonicalReasoning ? (model.thinkingLevelMap?.[reasoning] ?? fallback) : reasoning;
}

export function resolveResponsesReasoningEffort(
  model: Model<"openai-responses">,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
): OpenAIApiReasoningEffort | undefined;
export function resolveResponsesReasoningEffort<TApi extends Exclude<Api, "openai-responses">>(
  model: Model<TApi>,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
): ResponsesReasoningEffort | undefined;
export function resolveResponsesReasoningEffort<TApi extends Api>(
  model: Model<TApi>,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
): OpenAIApiReasoningEffort | undefined {
  const clampedReasoning = reasoning ? clampThinkingLevel(model, reasoning) : undefined;
  if (!clampedReasoning || clampedReasoning === "off") {
    return undefined;
  }
  const resolvedApiReasoning = resolveResponsesApiReasoningEffort(model, clampedReasoning);
  if (resolvedApiReasoning === undefined) {
    return undefined;
  }
  if (clampedReasoning === "max" && resolvedApiReasoning === "max") {
    return supportsOpenAIReasoningEffort(model, "max") ? "max" : "xhigh";
  }
  if (
    clampedReasoning === "minimal" &&
    resolvedApiReasoning === "minimal" &&
    model.provider === "openai" &&
    supportsOpenAIReasoningEffort(model, "max")
  ) {
    const effort = resolveOpenAIReasoningEffortForModel({ model, effort: "minimal" });
    return isResponsesReasoningEffort(effort) ? effort : undefined;
  }
  return resolvedApiReasoning;
}

export function applyCommonResponsesParams<TApi extends Api>(
  params: ResponseCreateParamsStreaming,
  model: Model<TApi>,
  context: Context,
  options?: ResponsesCommonParamsOptions,
  config?: { setDefaultReasoningOff?: boolean },
): void {
  if (options?.maxTokens) {
    params.max_output_tokens = Math.max(options.maxTokens, 16);
  }

  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    const converted = convertResponsesToolPayload(context.tools, { model });
    if (converted.tools.length > 0) {
      params.tools = converted.tools;
    }
  }

  if (!model.reasoning || isResponsesReasoningEffortDisabled(model)) {
    return;
  }

  const requestedEffort =
    options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
  if (requestedEffort !== undefined) {
    const effort = resolveResponsesApiReasoningEffort(model, requestedEffort);
    if (effort === undefined) {
      return;
    }
    params.reasoning = {
      effort: effort as NonNullable<typeof params.reasoning>["effort"],
      summary: options?.reasoningSummary || "auto",
    };
    params.include = ["reasoning.encrypted_content"];
  } else if ((config?.setDefaultReasoningOff ?? true) && model.thinkingLevelMap?.off !== null) {
    const effort = resolveResponsesApiReasoningEffort(model, "off", "none");
    if (effort === undefined) {
      return;
    }
    params.reasoning = {
      effort: effort as NonNullable<typeof params.reasoning>["effort"],
    };
  }
}

function buildResponsesRequestOptions(
  options: ResponsesLifecycleStreamOptions | undefined,
): ResponsesRequestOptions {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    maxRetries: options?.maxRetries ?? 0,
  };
}

function cleanStreamingScratchBuffers(output: AssistantMessage): void {
  for (const block of output.content) {
    delete (block as { index?: number }).index;
    // partialJson is only a streaming scratch buffer; never persist it.
    delete (block as { partialJson?: string }).partialJson;
  }
}

export async function runResponsesStreamLifecycle<TApi extends Api>(params: {
  stream: AssistantMessageEventStream;
  model: Model<TApi>;
  output: AssistantMessage;
  options?: ResponsesLifecycleStreamOptions;
  resolveRequestModel?: (model: Model<TApi>) => Model<TApi>;
  createClient: (model: Model<TApi>) => ResponsesStreamClient;
  buildParams: (
    model: Model<TApi>,
    replayMode: OpenAIResponsesReplayMode,
  ) => ResponsesLifecycleRequest;
  processStreamOptions?: OpenAIResponsesProcessStreamOptions;
}): Promise<void> {
  const { stream, output, options } = params;

  let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
  try {
    const model = params.resolveRequestModel?.(params.model) ?? params.model;
    const client = params.createClient(model);
    const buildRequest = async (replayMode: OpenAIResponsesReplayMode) => {
      let request = params.buildParams(model, replayMode);
      const nextRequest = await options?.onPayload?.(request, model);
      if (nextRequest !== undefined) {
        request = nextRequest as ResponsesLifecycleRequest;
      }
      return request;
    };
    const requestParams = await buildRequest("checkpoint");

    firstEventAbort = createFirstStreamEventAbortController(options?.signal);
    const { stream: openaiStream, response } = await createResponsesStreamWithEncryptedContentRetry(
      {
        client: client as never,
        request: requestParams as never,
        requestOptions: {
          ...buildResponsesRequestOptions(options),
          signal: firstEventAbort.signal,
        },
        model,
        buildFullHistoryRequest: () => buildRequest("full-history"),
        onCompactionRejected: (checkpoint) =>
          suppressOpenAIResponsesCompaction(output, model, options, checkpoint),
      },
    );
    const hookedOpenAIStream = withProviderResponseHook({
      stream: openaiStream,
      signal: firstEventAbort.signal,
      abort: firstEventAbort.abort,
      hook: createOpenAIResponseHook(options?.onResponse, response, model),
      onReady: () => stream.push({ type: "start", partial: output }),
    });

    const firstEventTimeoutMs = getFirstStreamEventTimeoutMs(options);
    const onFirstEventTimeout = getFirstStreamEventTimeoutHandler(options);
    const processStreamOptions =
      params.processStreamOptions ||
      firstEventTimeoutMs !== undefined ||
      onFirstEventTimeout !== undefined
        ? {
            ...params.processStreamOptions,
            firstEventTimeoutMs:
              params.processStreamOptions?.firstEventTimeoutMs ?? firstEventTimeoutMs,
            abortFirstEventStream:
              params.processStreamOptions?.abortFirstEventStream ?? firstEventAbort.abort,
            onFirstEventTimeout:
              params.processStreamOptions?.onFirstEventTimeout ?? onFirstEventTimeout,
            signal: params.processStreamOptions?.signal ?? options?.signal,
          }
        : undefined;
    await processResponsesStream(hookedOpenAIStream, output, stream, model, {
      ...processStreamOptions,
      reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
        sessionId: options?.sessionId,
        authProfileId: options?.authProfileId,
      }),
    });

    if (options?.signal?.aborted) {
      throw transportAbortError(options.signal);
    }

    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error(output.errorMessage ?? "An unknown error occurred");
    }

    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  } catch (error) {
    cleanStreamingScratchBuffers(output);
    const terminal = projectProviderError(error, options?.signal);
    Object.assign(output, terminal);
    stream.push({ type: "error", reason: terminal.stopReason, error: output });
    stream.end();
  } finally {
    firstEventAbort?.dispose();
  }
}
