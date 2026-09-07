// OpenAI ChatGPT Responses provider handles ChatGPT-authenticated response streams.
import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import {
  extractErrorCodeOrErrno,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type {
  Tool as OpenAITool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
  type OpenAIResponsesReplayMode,
} from "../transports/openai-responses-compaction-replay.js";
import { responsesPromptObserver } from "../transports/openai-responses-contracts.js";
import { ResponsesStreamFailure } from "../transports/openai-responses-debug.js";
import { createResponsesPromptEgressObserver } from "../transports/openai-responses-prompt-observer-internal.js";
import {
  commitResponsesEncryptedContentAttempt,
  isInvalidEncryptedContentError,
  resolveNextResponsesEncryptedContentAttempt,
  type ResponsesEncryptedContentAttempt,
} from "../transports/openai-responses-replay-internal.js";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import {
  createOpenAIProviderAcceptanceHook,
  createOpenAIResponseHook,
} from "../transports/openai-transport-shared.js";
import {
  assignTransportErrorDetails,
  notifyProviderStreamOpened,
  transportAbortError,
  withProviderResponseHook,
} from "../transports/transport-stream-shared.js";
import {
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseRetryAfterSeconds,
} from "../transports/transport-utils.js";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "../types.js";
import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  formatThrownValue,
} from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { resolveOpenAICodexAccountId } from "../utils/oauth/openai-chatgpt-jwt.js";
import { WEBSOCKET_NON_RETRYABLE_CLOSE_ERROR_CODE } from "../utils/retryable-network-errors.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  withFirstStreamEventTimeout,
} from "../utils/stream-first-event-timeout.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  CodexProtocolError,
  parseOpenAIChatGptResponsesSse,
} from "./openai-chatgpt-responses-protocol.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { supportsOpenAITemperature } from "./openai-reasoning-effort.js";
import {
  applyResponsesServiceTierPricing,
  convertResponsesMessages,
  convertResponsesToolPayload,
  createResponsesAssistantOutput,
  resolveResponsesReasoningEffort,
  resolveResponsesRequestReasoningEffort,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);

type ProcessWithOsBuiltinModule = typeof process & {
  getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
const os = loadNodeOs();

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);
const WEBSOCKET_TRANSPORT_ERROR_CODE = "ERR_WEBSOCKET_TRANSPORT";
// Only registered server/transport-unavailability closes may authorize retry or
// settled-turn finalization; peer policy/protocol rejections must fail closed.
const RETRYABLE_WEBSOCKET_CLOSE_CODES = new Set([1001, 1005, 1006, 1011, 1012, 1013, 1014, 1015]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES = 16 * 1024;

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);

// ============================================================================
// Types
// ============================================================================

interface OpenAICodexResponsesOptions extends BaseOpenAIStreamOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  textVerbosity?: "low" | "medium" | "high";
}

type CodexResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "queued"
  | "in_progress";

interface RequestBody {
  model: string;
  store?: boolean;
  stream?: boolean;
  instructions?: string;
  previous_response_id?: string;
  input?: ResponseInput;
  tools?: OpenAITool[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  text?: { verbosity?: string };
  include?: string[];
  prompt_cache_key?: string;
  [key: string]: unknown;
}

type ObserveResponsesPromptEgress = NonNullable<
  ReturnType<typeof createResponsesPromptEgressObserver>
>;

function resolveRequestTimeoutMs(options?: OpenAICodexResponsesOptions): number | undefined {
  const timeoutMs = options?.timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? resolveTimerTimeoutMs(timeoutMs, 1)
    : undefined;
}

function buildRequestSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return baseSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!baseSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([baseSignal, timeoutSignal]);
}

function isRequestTimeoutError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): boolean {
  if (timeoutMs === undefined || callerSignal?.aborted || !requestSignal?.aborted) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.message === "Request was aborted"
  );
}

type StreamFailureKind = "timeout" | "caller-abort" | "provider-failure" | "transport";

/** Local-only failure category for transport diagnostics; never provider text. */
function classifyStreamFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  requestTimedOut: boolean,
): StreamFailureKind {
  if (requestTimedOut) {
    return "timeout";
  }
  if (signal?.aborted) {
    return "caller-abort";
  }
  // CodexApiError carries a non-OK HTTP reply; both are provider decisions, not transport faults.
  return error instanceof ResponsesStreamFailure || error instanceof CodexApiError
    ? "provider-failure"
    : "transport";
}

function formatRequestTimeoutError(timeoutMs: number, cause: unknown): Error {
  return new Error(`Request timed out after ${timeoutMs}ms`, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

type ProcessWithZlibBuiltinModule = typeof process & {
  getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

function compressRequestBodyZstd(bodyJson: string): Uint8Array<ArrayBuffer> | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  const zlib = (process as ProcessWithZlibBuiltinModule).getBuiltinModule?.("node:zlib");
  if (!zlib || typeof zlib.zstdCompressSync !== "function") {
    return null;
  }
  try {
    const compressed = zlib.zstdCompressSync(bodyJson, {
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL,
      },
    });
    return Uint8Array.from(compressed);
  } catch {
    return null;
  }
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const streamOpenAICodexResponses: StreamFunction<
  "openai-chatgpt-responses",
  OpenAICodexResponsesOptions
> = (
  model: Model<"openai-chatgpt-responses">,
  context: Context,
  options?: OpenAICodexResponsesOptions,
) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const startedAt = Date.now();
    let requestTimeoutMs: number | undefined;
    let requestTimeoutSignal: AbortSignal | undefined;
    let activeSignal: AbortSignal | undefined;
    let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
    const output = createResponsesAssistantOutput(model);

    try {
      const unresolvedApiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      if (!unresolvedApiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      // WebSocket auth has no fetch seam; unwrap immediately before request construction.
      const apiKey = getAiTransportHost().resolveSecretSentinel(unresolvedApiKey);
      const modelHeaders = resolveAiTransportHeaderSentinels(model.headers);
      const optionHeaders = resolveAiTransportHeaderSentinels(options?.headers);

      const accountId = extractOpenAICodexAccountId(apiKey);
      const buildBody = async (replayMode: OpenAIResponsesReplayMode) => {
        let body = buildRequestBody(model, context, options, replayMode);
        const nextBody = await options?.onPayload?.(body, model);
        if (nextBody !== undefined) {
          body = nextBody as RequestBody;
        }
        return body;
      };
      let semanticAttempt: ResponsesEncryptedContentAttempt<RequestBody> = {
        kind: "initial",
        request: await buildBody("checkpoint"),
      };
      const commitSemanticAttempt = (attempt: ResponsesEncryptedContentAttempt<RequestBody>) =>
        commitResponsesEncryptedContentAttempt(attempt, (checkpoint) =>
          suppressOpenAIResponsesCompaction(output, model, options, checkpoint),
        );
      const observePromptEgress = createResponsesPromptEgressObserver(
        options,
        context.systemPrompt,
      );
      // NOTE: when options.sessionId is absent, this falls back to a fresh random id
      // per request, which forfeits session-affinity routing on the WS transport (the
      // backend routes by session_id/x-client-request-id). Left as-is for this fix;
      // see the SSE-path session_id addition in buildOpenAIClientHeaders (agents/openai-transport-stream.ts).
      const sessionId = clampOpenAIPromptCacheKey(options?.sessionId);
      requestTimeoutMs = resolveRequestTimeoutMs(options);
      requestTimeoutSignal = buildRequestSignal(options?.signal, requestTimeoutMs);
      firstEventAbort = createFirstStreamEventAbortController(requestTimeoutSignal);
      activeSignal = firstEventAbort.signal;
      const requestOptions =
        activeSignal === options?.signal ? options : { ...options, signal: activeSignal };
      const transport = options?.transport || "auto";
      const websocketDisabledForSession =
        transport === "auto" && isWebSocketSseFallbackActive(options?.sessionId);

      if (transport !== "sse" && !websocketDisabledForSession) {
        const websocketHeaders = buildWebSocketHeaders(
          modelHeaders,
          optionHeaders,
          accountId,
          apiKey,
          sessionId || createCodexRequestId(),
        );
        let websocketStarted = false;
        let websocketRequestSent = false;
        let retriedWebSocketConnectionLimit = false;
        while (true) {
          const activeAttempt = semanticAttempt;
          websocketStarted = false;
          websocketRequestSent = false;
          try {
            await processWebSocketStream(
              resolveCodexWebSocketUrl(model.baseUrl),
              activeAttempt.request,
              websocketHeaders,
              output,
              stream,
              model,
              () => {
                websocketStarted = true;
              },
              () => {
                commitSemanticAttempt(activeAttempt);
              },
              requestOptions,
              firstEventAbort.abort,
              observePromptEgress,
              activeAttempt.kind,
              () => {
                websocketRequestSent = true;
              },
              options?.signal,
            );

            if (activeSignal?.aborted) {
              throw transportAbortError(activeSignal);
            }
            if (output.stopReason === "aborted" || output.stopReason === "error") {
              throw new CodexApiError(output.errorMessage ?? "An unknown error occurred");
            }
            stream.push({
              type: "done",
              reason: output.stopReason as "stop" | "length" | "toolUse",
              message: output,
            });
            stream.end();
            return;
          } catch (error) {
            const aborted = activeSignal?.aborted;
            // Observer and local send failures happen before dispatch and must not
            // be classified as provider rejection of encrypted replay state.
            const nextSemanticAttempt =
              !aborted &&
              websocketRequestSent &&
              !websocketStarted &&
              error instanceof CodexApiError &&
              isInvalidEncryptedContentError(error)
                ? await resolveNextResponsesEncryptedContentAttempt(activeAttempt, error, {
                    buildFullHistoryRequest: () => buildBody("full-history"),
                  })
                : undefined;
            if (nextSemanticAttempt) {
              semanticAttempt = nextSemanticAttempt;
              retriedWebSocketConnectionLimit = false;
              continue;
            }
            const connectionLimitBeforeStart =
              !websocketStarted && isWebSocketConnectionLimitReachedError(error);
            if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
              retriedWebSocketConnectionLimit = true;
              continue;
            }
            if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
              throw error;
            }
            appendAssistantMessageDiagnostic(
              output,
              createAssistantMessageDiagnostic("provider_transport_failure", error, {
                configuredTransport: transport,
                fallbackTransport: transport === "auto" && !websocketStarted ? "sse" : undefined,
                eventsEmitted: websocketStarted,
                phase: websocketStarted
                  ? "after_message_stream_start"
                  : "before_message_stream_start",
                requestBytes: new TextEncoder().encode(JSON.stringify(activeAttempt.request))
                  .byteLength,
              }),
            );
            if (transport === "auto" && options?.sessionId) {
              websocketSseFallbackSessions.add(options.sessionId);
            }
            if (websocketStarted || transport !== "auto") {
              throw error;
            }
            break;
          }
        }
      }

      let response: Response | undefined;
      while (true) {
        const activeAttempt = semanticAttempt;
        response = undefined;
        const sseHeaders = buildSSEHeaders(
          modelHeaders,
          optionHeaders,
          accountId,
          apiKey,
          sessionId,
        );
        const bodyJson = JSON.stringify(activeAttempt.request);
        const canCompressSseBody =
          model.provider === "openai" && !sseHeaders.has("content-encoding");
        const compressedBody = canCompressSseBody ? compressRequestBodyZstd(bodyJson) : null;
        if (compressedBody) {
          sseHeaders.set("content-encoding", "zstd");
        }
        const sseBody: BodyInit = compressedBody ?? bodyJson;

        if (activeSignal?.aborted) {
          throw transportAbortError(activeSignal);
        }
        observePromptEgress?.(activeAttempt.request, {
          egress: "native-codex-sse",
          payloadVariant: activeAttempt.kind,
        });

        let attemptResponse: Response;
        try {
          attemptResponse = await fetch(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers: sseHeaders,
            body: sseBody,
            signal: activeSignal,
          });
        } catch (error) {
          if (error instanceof Error) {
            if (
              isRequestTimeoutError(
                error,
                options?.signal,
                requestTimeoutSignal,
                requestTimeoutMs,
              ) &&
              requestTimeoutMs !== undefined
            ) {
              throw formatRequestTimeoutError(requestTimeoutMs, error);
            }
            if (error.name === "AbortError" || error.message === "Request was aborted") {
              throw new Error("Request was aborted", { cause: error });
            }
            if (error.name === "TimeoutError" && requestTimeoutMs !== undefined) {
              throw new Error(`Request timed out after ${requestTimeoutMs}ms`, { cause: error });
            }
          }
          throw toErrorObject(error, String(error));
        }

        response = attemptResponse;
        if (attemptResponse.ok) {
          if (!attemptResponse.body) {
            throw new Error("No response body");
          }
          if (activeSignal?.aborted) {
            throw transportAbortError(activeSignal);
          }
          commitSemanticAttempt(activeAttempt);
          break;
        }

        const hookStream = withFirstStreamEventTimeout(
          withProviderResponseHook({
            signal: firstEventAbort.signal,
            abort: firstEventAbort.abort,
            hook: createOpenAIResponseHook(options?.onResponse, attemptResponse, model),
          }),
          {
            provider: model.provider,
            api: model.api,
            model: model.id,
            timeoutMs: getFirstStreamEventTimeoutMs(options) ?? 0,
            stage: "responses",
            abort: firstEventAbort.abort,
            onTimeout: getFirstStreamEventTimeoutHandler(options),
          },
        );
        const [errorText] = await Promise.all([
          readChatGptResponsesErrorTextLimited(attemptResponse, activeSignal),
          hookStream[Symbol.asyncIterator]().next(),
        ]);
        const terminalResponseError = parseErrorResponse(errorText, attemptResponse);
        if (activeSignal?.aborted) {
          throw transportAbortError(activeSignal);
        }
        const nextSemanticAttempt = await resolveNextResponsesEncryptedContentAttempt(
          activeAttempt,
          terminalResponseError,
          { buildFullHistoryRequest: () => buildBody("full-history") },
        );
        if (!nextSemanticAttempt) {
          throw terminalResponseError;
        }
        semanticAttempt = nextSemanticAttempt;
      }

      const hookedResponseStream = withProviderResponseHook({
        stream: mapCodexEvents(parseOpenAIChatGptResponsesSse(response)),
        signal: firstEventAbort.signal,
        abort: firstEventAbort.abort,
        hook: createOpenAIProviderAcceptanceHook(options, response, model),
        onReady: () => stream.push({ type: "start", partial: output }),
      });
      await processResponsesStream(hookedResponseStream, output, stream, model, {
        serviceTier: options?.serviceTier,
        firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
        abortFirstEventStream: firstEventAbort.abort,
        onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
        signal: options?.signal,
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
          sessionId: options?.sessionId,
          authProfileId: options?.authProfileId,
        }),
        resolveServiceTier: resolveCodexServiceTier,
        applyServiceTierPricing: (usage, serviceTier) =>
          applyResponsesServiceTierPricing(usage, serviceTier, model),
      });

      if (activeSignal?.aborted) {
        throw transportAbortError(activeSignal);
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage ?? "An unknown error occurred");
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      const requestTimedOut =
        isRequestTimeoutError(error, options?.signal, requestTimeoutSignal, requestTimeoutMs) &&
        requestTimeoutMs !== undefined;
      const normalizedError =
        requestTimedOut && requestTimeoutMs !== undefined
          ? formatRequestTimeoutError(requestTimeoutMs, error)
          : error;
      for (const block of output.content) {
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      const terminal = assignTransportErrorDetails(output, normalizedError, options?.signal);
      // Log only locally-derived facts: timing and a fixed failure category. No
      // projected provider field (message, body, code, type, name) is logged —
      // all of them are provider-controlled text that can carry prompt- or
      // response-derived content.
      getAiTransportHost().logWarn("openai-transport", "ChatGPT Responses stream terminated", {
        provider: model.provider,
        api: model.api,
        model: model.id,
        transport: options?.transport || "auto",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        stopReason: terminal.stopReason,
        failureKind: classifyStreamFailure(error, options?.signal, requestTimedOut),
      });
      stream.push({ type: "error", reason: terminal.stopReason, error: output });
      stream.end();
    } finally {
      firstEventAbort?.dispose();
    }
  })();

  return stream;
};

export const streamSimpleOpenAICodexResponses: StreamFunction<
  "openai-chatgpt-responses",
  SimpleStreamOptions
> = (model: Model<"openai-chatgpt-responses">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const resolvedOptions = {
    ...buildBaseOptions(model, options, apiKey),
    authProfileId: (options as (SimpleStreamOptions & { authProfileId?: string }) | undefined)
      ?.authProfileId,
    reasoningEffort: resolveResponsesReasoningEffort(model, options?.reasoning),
  } satisfies OpenAICodexResponsesOptions;
  responsesPromptObserver.copy(options, resolvedOptions);
  return streamOpenAICodexResponses(model, context, resolvedOptions);
};

// ============================================================================
// Request Building
// ============================================================================

function buildRequestBody(
  model: Model<"openai-chatgpt-responses">,
  context: Context,
  options?: OpenAICodexResponsesOptions,
  replayMode: OpenAIResponsesReplayMode = "checkpoint",
): RequestBody {
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    replayResponsesItemIds: false,
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    replayMode,
  });

  const body: RequestBody = {
    model: model.id,
    store: false,
    stream: true,
    instructions:
      stripSystemPromptCacheBoundary(context.systemPrompt ?? "") || "You are a helpful assistant.",
    input: messages,
    text: { verbosity: options?.textVerbosity || "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key:
      options?.cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
  };

  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
    body.temperature = options.temperature;
  }

  if (options?.serviceTier !== undefined) {
    body.service_tier = options.serviceTier;
  }

  if (context.tools) {
    const tools = convertResponsesToolPayload(context.tools, { strict: null });
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
  }

  const effort =
    options?.reasoningEffort === undefined
      ? undefined
      : resolveResponsesRequestReasoningEffort(model, options.reasoningEffort);
  if (effort !== undefined) {
    body.reasoning = {
      effort,
      summary: options?.reasoningSummary ?? "auto",
    };
  }

  return body;
}

function resolveCodexServiceTier(
  responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
  if (
    responseServiceTier === "default" &&
    (requestServiceTier === "flex" || requestServiceTier === "priority")
  ) {
    return requestServiceTier;
  }
  return responseServiceTier ?? requestServiceTier;
}

function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

class CodexApiError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly payload?: Record<string, unknown>;

  constructor(
    message: string,
    options?: {
      code?: string;
      status?: number;
      payload?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "CodexApiError";
    this.code = options?.code;
    this.status = options?.status;
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

function isCodexNonTransportError(error: unknown): boolean {
  return (
    error instanceof CodexApiError ||
    error instanceof CodexProtocolError ||
    error instanceof ResponsesStreamFailure
  );
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function extractCodexEventError(event: Record<string, unknown>): {
  code?: string;
  message?: string;
} {
  const nested =
    event.error && typeof event.error === "object"
      ? (event.error as Record<string, unknown>)
      : undefined;
  return {
    code:
      typeof event.code === "string"
        ? event.code
        : typeof nested?.code === "string"
          ? nested.code
          : undefined,
    message:
      typeof event.message === "string"
        ? event.message
        : typeof nested?.message === "string"
          ? nested.message
          : undefined,
  };
}

async function* mapCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<ResponseStreamEvent> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) {
      continue;
    }

    if (type === "error") {
      const { code, message } = extractCodexEventError(event);
      throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
        code,
        payload: event,
      });
    }

    if (
      type === "response.done" ||
      type === "response.completed" ||
      type === "response.incomplete"
    ) {
      const response = (event as { response?: { status?: unknown } }).response;
      const normalizedResponse = response
        ? { ...response, status: normalizeCodexStatus(response.status) }
        : response;
      yield {
        ...event,
        type: type === "response.done" ? "response.completed" : type,
        response: normalizedResponse,
      } as ResponseStreamEvent;
      return;
    }

    yield event as unknown as ResponseStreamEvent;
  }
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
  if (typeof status !== "string") {
    return undefined;
  }
  return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus)
    ? (status as CodexResponseStatus)
    : undefined;
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

interface CachedWebSocketContinuationState {
  lastRequestBody: RequestBody;
  lastResponseId: string;
  lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
  socket: WebSocketLike;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuationState;
}

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketSseFallbackSessions = new Set<string>();
let cachedWebsocket: WebSocketConstructor | null = null;

export function resetOpenAICodexWebSocketStateForTest(): void {
  cachedWebsocket = null;
  websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
  const closeEntry = (entry: CachedWebSocketConnection) => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    closeWebSocketSilently(entry.socket, 1000, "debug_close");
  };
  // Sticky SSE fallback follows the provider session-resource lifecycle;
  // otherwise reused session ids stay degraded and the set grows indefinitely.
  if (sessionId) {
    websocketSseFallbackSessions.delete(sessionId);
    const entry = websocketSessionCache.get(sessionId);
    if (entry) {
      closeEntry(entry);
    }
    websocketSessionCache.delete(sessionId);
    return;
  }
  for (const entry of websocketSessionCache.values()) {
    closeEntry(entry);
  }
  websocketSessionCache.clear();
  websocketSseFallbackSessions.clear();
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

async function getWebSocketConstructor(): Promise<WebSocketConstructor | null> {
  if (cachedWebsocket) {
    return cachedWebsocket;
  }

  // bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
  // Keep the fallback until Bun supports proxy envs in websocket.
  if (
    process?.versions?.bun &&
    (process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy)
  ) {
    const m = await dynamicImport("proxy-from-env");
    const getProxyForUrl = (m as { getProxyForUrl: (url: string | object | URL) => string })
      .getProxyForUrl;

    cachedWebsocket = class extends WebSocket {
      constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
        let opts: Record<string, unknown>;
        if (Array.isArray(options) || typeof options === "string") {
          opts = { protocols: options };
        } else {
          opts = { ...options };
        }

        const proxy = getProxyForUrl(
          url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
        );
        super(url, { ...opts, ...(proxy ? { proxy } : {}) } as string | string[] | undefined);
      }
    };
    return cachedWebsocket;
  }

  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") {
    return null;
  }
  return ctor as unknown as WebSocketConstructor;
}

function createWebSocketTransportError(message: string, cause?: Error): Error {
  // ErrorEvents can flatten the underlying socket failure. Preserve its code
  // when available and retain a stable producer fact when it is opaque.
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: extractErrorCodeOrErrno(cause) ?? WEBSOCKET_TRANSPORT_ERROR_CODE,
  });
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
  const readyState = (socket as { readyState?: unknown }).readyState;
  return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
  const readyState = getWebSocketReadyState(socket);
  // If readyState is unavailable, assume the runtime keeps it open/reusable.
  return readyState === undefined || readyState === 1;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
  return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {}
}

// A delayed release or expiry owns its captured socket, not a newer session lease.
function deleteOwnedWebSocketSession(sessionId: string, entry: CachedWebSocketConnection): void {
  if (websocketSessionCache.get(sessionId) === entry) {
    websocketSessionCache.delete(sessionId);
  }
}

// An acquire that awaited connectWebSocket() must not clobber a newer lease a
// concurrent request installed during the await. Install the fresh entry only
// when the cache still matches what this acquire left behind before the await:
// the stale entry it observed (and did not remove), or undefined once it removed
// its own stale entry (or for a first connect with no prior entry). A different
// cached entry means a concurrent request already won this session.
function setOwnedWebSocketSession(
  sessionId: string,
  entry: CachedWebSocketConnection,
  expected: CachedWebSocketConnection | undefined,
): boolean {
  if (websocketSessionCache.get(sessionId) === expected) {
    websocketSessionCache.set(sessionId, entry);
    return true;
  }
  return false;
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) {
      return;
    }
    closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
    deleteOwnedWebSocketSession(sessionId, entry);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

async function connectWebSocket(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
): Promise<WebSocketLike> {
  const WebSocketCtor = await getWebSocketConstructor();
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is not available in this runtime");
  }

  const wsHeaders = headersToRecord(headers);
  delete wsHeaders["OpenAI-Beta"];

  return new Promise<WebSocketLike>((resolve, reject) => {
    let settled = false;
    let socket: WebSocketLike;

    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const onOpen: WebSocketListener = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError: WebSocketListener = (event) => {
      const error = extractWebSocketError(event);
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose: WebSocketListener = (event) => {
      const error = extractWebSocketCloseError(event);
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.close(1000, "aborted");
      reject(new Error("Request was aborted"));
    };

    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}

async function acquireWebSocket(
  url: string,
  headers: Headers,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<{
  socket: WebSocketLike;
  entry?: CachedWebSocketConnection;
  release: (options?: { keep?: boolean }) => void;
}> {
  if (!sessionId) {
    const socket = await connectWebSocket(url, headers, signal);
    return {
      socket,
      release: ({ keep } = {}) => {
        if (keep === false) {
          closeWebSocketSilently(socket);
          return;
        }
        closeWebSocketSilently(socket);
      },
    };
  }

  const cached = websocketSessionCache.get(sessionId);
  // Track what the cache is expected to hold after this acquire's own cleanup,
  // so the post-await install only proceeds when no concurrent request installed
  // a newer entry. Starts as the observed entry; reset to undefined once this
  // acquire removes its own stale entry, since owner-checked delete leaves the
  // cache empty (and a concurrent winner would fill it with a different entry).
  let expectedCacheValue: CachedWebSocketConnection | undefined = cached;
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (!cached.busy && isWebSocketSessionExpired(cached)) {
      closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
      deleteOwnedWebSocketSession(sessionId, cached);
      expectedCacheValue = undefined;
    } else if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            deleteOwnedWebSocketSession(sessionId, cached);
            return;
          }
          cached.busy = false;
          scheduleSessionWebSocketExpiry(sessionId, cached);
        },
      };
    }
    if (cached.busy) {
      const socket = await connectWebSocket(url, headers, signal);
      return {
        socket,
        release: () => {
          closeWebSocketSilently(socket);
        },
      };
    }
    if (!isWebSocketReusable(cached.socket)) {
      closeWebSocketSilently(cached.socket);
      deleteOwnedWebSocketSession(sessionId, cached);
      expectedCacheValue = undefined;
    }
  }

  const socket = await connectWebSocket(url, headers, signal);
  const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
  // Install only if the cache still matches what this acquire left behind (the
  // stale entry it removed, or empty for a first connect). A different cached
  // entry means a concurrent request already won this session during the await;
  // let it keep the lease and leave this socket transient.
  const ownsCache = setOwnedWebSocketSession(sessionId, entry, expectedCacheValue);
  return {
    socket,
    entry: ownsCache ? entry : undefined,
    release: ({ keep } = {}) => {
      if (!ownsCache || !keep || !isWebSocketReusable(entry.socket)) {
        closeWebSocketSilently(entry.socket);
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
        }
        deleteOwnedWebSocketSession(sessionId, entry);
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(sessionId, entry);
    },
  };
}

function extractWebSocketError(event: unknown): Error {
  if (event && typeof event === "object") {
    const message = "message" in event ? (event as { message?: unknown }).message : undefined;
    const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
    const eventMessage = typeof message === "string" && message.length > 0 ? message : undefined;
    if (nestedError !== undefined) {
      const cause = toErrorObject(nestedError, eventMessage ?? "WebSocket error");
      return createWebSocketTransportError(
        eventMessage ?? (cause.message || "WebSocket error"),
        cause,
      );
    }
    if (eventMessage) {
      return createWebSocketTransportError(eventMessage);
    }
  }
  return createWebSocketTransportError("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === "object") {
    const code = "code" in event ? (event as { code?: unknown }).code : undefined;
    const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
    const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
    const codeText = typeof code === "number" ? ` ${code}` : "";
    let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
    if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
      reasonText = " message too big";
    }
    const message = `WebSocket closed${codeText}${reasonText}`;
    const error =
      typeof code === "number" && RETRYABLE_WEBSOCKET_CLOSE_CODES.has(code)
        ? createWebSocketTransportError(message)
        : Object.assign(new Error(message), { code: WEBSOCKET_NON_RETRYABLE_CLOSE_ERROR_CODE });
    return Object.assign(error, {
      name: "WebSocketCloseError",
      closeCode: typeof code === "number" ? code : undefined,
      reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
      wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
    });
  }
  return createWebSocketTransportError("WebSocket closed");
}

async function* parseWebSocket(
  socket: WebSocketLike,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let failed: Error | null = null;
  let sawCompletion = false;

  const wake = () => {
    if (!pending) {
      return;
    }
    const resolve = pending;
    pending = null;
    resolve();
  };

  const onMessage: WebSocketListener = (event) => {
    const data =
      event && typeof event === "object" && "data" in event
        ? (event as { data?: unknown }).data
        : undefined;
    if (typeof data !== "string") {
      // Codex response events are text frames. Keep malformed transport failures
      // on the shared marker so callers receive the canonical retry guidance.
      failed = new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, {
        payload: data,
      });
      done = true;
      wake();
      return;
    }

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (
        type === "response.completed" ||
        type === "response.done" ||
        type === "response.incomplete"
      ) {
        sawCompletion = true;
        done = true;
      }
      queue.push(parsed);
      wake();
    } catch (cause) {
      failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
        cause,
        payload: data,
      });
      done = true;
      wake();
    }
  };

  const onError: WebSocketListener = (event) => {
    failed = extractWebSocketError(event);
    done = true;
    wake();
  };

  const onClose: WebSocketListener = (event) => {
    if (sawCompletion) {
      done = true;
      wake();
      return;
    }
    if (!failed) {
      failed = extractWebSocketCloseError(event);
    }
    done = true;
    wake();
  };

  const onAbort = () => {
    failed = new Error("Request was aborted");
    done = true;
    wake();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw transportAbortError(signal);
      }
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (done) {
        break;
      }
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }

    if (failed) {
      throw toErrorObject(failed, "Non-Error thrown");
    }
    if (!sawCompletion) {
      throw new Error("WebSocket stream closed before response.completed");
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
  return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
  body: RequestBody,
  continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
  if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
    return undefined;
  }

  const currentInput = body.input ?? [];
  const baseline = [
    ...(continuation.lastRequestBody.input ?? []),
    ...continuation.lastResponseItems,
  ];
  if (currentInput.length < baseline.length) {
    return undefined;
  }

  const prefix = currentInput.slice(0, baseline.length);
  if (!responseInputsEqual(prefix, baseline)) {
    return undefined;
  }

  return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(
  entry: CachedWebSocketConnection,
  body: RequestBody,
): RequestBody {
  const continuation = entry.continuation;
  if (!continuation) {
    return body;
  }

  const delta = getCachedWebSocketInputDelta(body, continuation);
  if (!delta || !continuation.lastResponseId) {
    entry.continuation = undefined;
    return body;
  }

  return {
    ...body,
    previous_response_id: continuation.lastResponseId,
    input: delta,
  };
}

async function* startWebSocketOutputOnFirstEvent(
  events: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  onFirstProviderEvent: () => void,
  reportStreamOpened: () => Promise<void>,
  onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
  let started = false;
  for await (const event of events) {
    if (!started) {
      started = true;
      onFirstProviderEvent();
      onStart();
      await reportStreamOpened();
      stream.push({ type: "start", partial: output });
    }
    yield event;
  }
}

async function processWebSocketStream(
  url: string,
  body: RequestBody,
  headers: Headers,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-chatgpt-responses">,
  onFirstProviderEvent: () => void,
  onStart: () => void,
  options?: OpenAICodexResponsesOptions,
  abortFirstEventStream?: (reason: Error) => void,
  observePromptEgress?: ObserveResponsesPromptEgress,
  payloadVariant: ResponsesEncryptedContentAttempt<RequestBody>["kind"] = "initial",
  onRequestSent?: () => void,
  // Stream progress must be reported on the caller's signal: the runner idle
  // watchdog listens there, while `options.signal` here is the request-scoped
  // abort composite that nothing outside this provider observes.
  activitySignal?: AbortSignal,
): Promise<void> {
  const { socket, entry, release } = await acquireWebSocket(
    url,
    headers,
    options?.sessionId,
    options?.signal,
  );
  let keepConnection = true;
  const useCachedContext =
    options?.transport === "websocket-cached" || options?.transport === "auto";
  // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
  // WebSocket continuation still works via connection-scoped previous_response_id state.
  const fullBody = body;
  const requestBody =
    useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
  try {
    if (options?.signal?.aborted) {
      throw transportAbortError(options.signal);
    }
    observePromptEgress?.(requestBody, {
      egress: "native-codex-websocket",
      payloadVariant,
    });
    socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    onRequestSent?.();
    await processResponsesStream(
      startWebSocketOutputOnFirstEvent(
        mapCodexEvents(parseWebSocket(socket, options?.signal)),
        output,
        stream,
        onFirstProviderEvent,
        () =>
          notifyProviderStreamOpened({
            options,
            cancelStream: () => {
              keepConnection = false;
              closeWebSocketSilently(socket);
            },
          }),
        onStart,
      ),
      output,
      stream,
      model,
      {
        serviceTier: options?.serviceTier,
        firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
        abortFirstEventStream,
        onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
        signal: activitySignal ?? options?.signal,
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
          sessionId: options?.sessionId,
          authProfileId: options?.authProfileId,
        }),
        resolveServiceTier: resolveCodexServiceTier,
        applyServiceTierPricing: (usage, serviceTier) =>
          applyResponsesServiceTierPricing(usage, serviceTier, model),
      },
    );
    if (options?.signal?.aborted) {
      keepConnection = false;
    } else if (useCachedContext && entry && output.responseId) {
      const responseItems = convertResponsesMessages(
        model,
        { messages: [output] },
        CODEX_TOOL_CALL_PROVIDERS,
        {
          includeSystemPrompt: false,
          replayResponsesItemIds: false,
          sessionId: options?.sessionId,
          authProfileId: options?.authProfileId,
        },
      ).filter((item) => item.type !== "function_call_output");
      entry.continuation = {
        lastRequestBody: fullBody,
        lastResponseId: output.responseId,
        lastResponseItems: responseItems,
      };
    }
  } catch (error) {
    if (entry) {
      entry.continuation = undefined;
    }
    keepConnection = false;
    throw error;
  } finally {
    release({ keep: keepConnection });
  }
}

// ============================================================================
// Error Handling
// ============================================================================

async function readChatGptResponsesErrorTextLimited(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let reachedLimit = false;
  let completed = false;
  let cancelPromise: Promise<void> | undefined;
  const cancel = () => {
    cancelPromise ??= reader.cancel(signal?.reason).catch(() => {});
    return cancelPromise;
  };
  const onAbort = () => {
    void cancel();
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const remaining = OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES - total;
      if (remaining <= 0) {
        reachedLimit = true;
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (total >= OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES) {
        reachedLimit = true;
        break;
      }
    }
    // A capped prefix may end mid-sequence. Flushing only after EOF avoids
    // inventing a replacement character while preserving malformed full bodies.
    if (!reachedLimit) {
      text += decoder.decode();
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      // This provider module is browser-safe, so keep error-body cleanup on Web APIs.
      await cancel();
    }
    try {
      reader.releaseLock();
    } catch {}
  }

  return text;
}

function parseErrorResponse(raw: string, response: Response): CodexApiError {
  const { status, statusText } = response;
  let message = raw || statusText || "Request failed";
  let friendlyMessage: string | undefined;
  let code: string | undefined;

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        code?: string;
        type?: string;
        message?: string;
        plan_type?: string;
        resets_at?: number;
      };
    };
    const err = parsed?.error;
    if (err) {
      code = err.code || err.type || undefined;
      if (
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code ?? "") ||
        status === 429
      ) {
        const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      message = err.message || friendlyMessage || message;
    }
  } catch {}

  const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
  // The canonical projection retains HTTP status; retry owners read its bounded
  // terminal text for pacing, matching formatAnthropicMessagesHttpError.
  const retryAfterSuffix = Number.isFinite(retryAfterSeconds)
    ? `; Retry-After: ${Math.ceil(retryAfterSeconds ?? 0)} seconds`
    : "";
  return new CodexApiError(`${friendlyMessage || message}${retryAfterSuffix}`, { code, status });
}

// ============================================================================
// Auth & Headers
// ============================================================================

export function extractOpenAICodexAccountId(token: string): string {
  const accountId = resolveOpenAICodexAccountId(token);
  if (accountId) {
    return accountId;
  }
  throw new Error("Failed to extract accountId from token");
}

function createCodexRequestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `codex_${suffix}`;
  }
  throw new Error("Secure random request id generation is unavailable");
}

function buildBaseCodexHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
): Headers {
  const headers = new Headers(initHeaders);
  for (const [key, value] of Object.entries(additionalHeaders || {})) {
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "openclaw");
  const userAgent = os
    ? `openclaw (${os.platform()} ${os.release()}; ${os.arch()})`
    : "openclaw (browser)";
  headers.set("User-Agent", userAgent);
  return headers;
}

function buildSSEHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
  sessionId?: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  if (sessionId) {
    headers.set("session_id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }

  return headers;
}

function buildWebSocketHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
  requestId: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", requestId);
  headers.set("session_id", requestId);
  return headers;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
