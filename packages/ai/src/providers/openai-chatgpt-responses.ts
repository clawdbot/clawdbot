// OpenAI ChatGPT Responses provider handles ChatGPT-authenticated response streams.
import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import type {
  Tool as OpenAITool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

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

import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  resolveTimerTimeoutMs,
  clampTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { getEnvApiKey } from "../env-api-keys.js";
import {
  getAiTransportHost,
  resolveAiTransportHeaderSentinels,
  type AiModelWebSocket,
} from "../host.js";
import { parseRetryAfterHttpDateMs } from "../internal/retry-after.js";
import { sleepWithAbort } from "../internal/retry-sleep.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { buildGuardedModelFetchResult } from "../transports/host-policy.js";
import {
  createModelTransportAttemptAuthority,
  createModelTransportEventScope,
  type ModelTransportAttemptAuthority,
  type ModelTransportConnectionReason,
  type ModelTransportEventScope,
} from "../transports/model-transport-accounting-internal.js";
import { responsesPromptObserver } from "../transports/openai-responses-contracts.js";
import { createResponsesPromptEgressObserver } from "../transports/openai-responses-prompt-observer-internal.js";
import {
  processResponsesStream,
  ResponsesStreamFailure,
} from "../transports/openai-responses-stream-internal.js";
import { transportAbortError } from "../transports/transport-stream-shared.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../types.js";
import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  formatThrownValue,
} from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { resolveOpenAICodexAccountId } from "../utils/oauth/openai-chatgpt-jwt.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { createSseByteGuard } from "../utils/streaming-byte-guard.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { inspectTlsCertificateError } from "../utils/tls-certificate-errors.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { supportsOpenAITemperature } from "./openai-reasoning-effort.js";
import {
  applyResponsesServiceTierPricing,
  convertResponsesMessages,
  convertResponsesToolPayload,
  createResponsesAssistantOutput,
  resolveResponsesReasoningEffort,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_REQUEST_MAX_RETRIES = 4;
const DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const WEBSOCKET_BASE_DELAY_MS = 200;
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const WEBSOCKET_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const WEBSOCKET_MAX_BUFFERED_CHUNKS = 1024;
const WEBSOCKET_MAX_FRAGMENTS = 1024;
const WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES = 16 * 1024;
const OPENAI_CHATGPT_RESPONSES_SUCCESS_BODY_MAX_BYTES = 16 * 1024 * 1024;

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

interface OpenAICodexResponsesOptions extends StreamOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  textVerbosity?: "low" | "medium" | "high";
  threadId?: string;
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

// ============================================================================
// Retry Helpers
// ============================================================================

function isRetryableError(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

function resolveHttpRetryDelayMs(response: Response, attempt: number): number {
  const fallbackMs = BASE_DELAY_MS * 2 ** attempt;
  const retryAfterMs = response.headers.get("retry-after-ms");
  if (retryAfterMs) {
    const trimmed = retryAfterMs.trim();
    const millis = Number(trimmed);
    if (/^\d+(?:\.\d+)?$/.test(trimmed) && Number.isFinite(millis)) {
      return clampTimerTimeoutMs(millis, 0) ?? fallbackMs;
    }
  }

  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return fallbackMs;
  }
  const trimmed = retryAfter.trim();
  const seconds = Number(trimmed);
  if (/^\d+$/.test(trimmed) && Number.isFinite(seconds)) {
    return clampTimerTimeoutMs(seconds * 1000, 0) ?? fallbackMs;
  }
  const retryAt = parseRetryAfterHttpDateMs(trimmed);
  return retryAt === undefined
    ? fallbackMs
    : (clampTimerTimeoutMs(retryAt - Date.now(), 0) ?? fallbackMs);
}

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
  const requestId = options?.requestId ?? createCodexRequestId();
  const transportAccounting = createModelTransportEventScope({
    model,
    ...(options?.requestId ? { callId: options.requestId } : {}),
    scopeId: requestId,
  });

  void (async () => {
    let requestTimeoutMs: number | undefined;
    let requestTimeoutSignal: AbortSignal | undefined;
    let activeSignal: AbortSignal | undefined;
    let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
    let activeTransport =
      options?.transport === "sse" ? "native-codex-sse" : "native-codex-websocket";
    let routePhaseSubmitted = false;
    let routePhaseZeroSubmissionObserved = false;
    let routePhaseSubmissionUnverified = false;
    let sseSubmissionAttested = false;
    let sseStartsAfterFallback = false;
    let websocketSessionEpochLease: { epoch: WebSocketSessionEpoch; sessionId: string } | undefined;
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
      let body = buildRequestBody(model, context, options);
      const nextBody = await options?.onPayload?.(body, model);
      if (nextBody !== undefined) {
        body = nextBody as RequestBody;
      }
      const observePromptEgress = createResponsesPromptEgressObserver(
        options,
        context.systemPrompt,
      );
      const sessionLifecycleId = options?.sessionId;
      const sessionId = clampOpenAIPromptCacheKey(sessionLifecycleId);
      const threadId = clampOpenAIPromptCacheKey(options?.threadId) ?? sessionId ?? requestId;
      const websocketRequestSessionEpoch = sessionLifecycleId
        ? retainWebSocketSessionEpoch(sessionLifecycleId)
        : undefined;
      if (sessionLifecycleId && websocketRequestSessionEpoch) {
        websocketSessionEpochLease = {
          epoch: websocketRequestSessionEpoch,
          sessionId: sessionLifecycleId,
        };
      }
      const websocketRequestSessionGeneration = websocketRequestSessionEpoch?.generation;
      requestTimeoutMs = resolveRequestTimeoutMs(options);
      requestTimeoutSignal = buildRequestSignal(options?.signal, requestTimeoutMs);
      firstEventAbort = createFirstStreamEventAbortController(requestTimeoutSignal);
      activeSignal = firstEventAbort.signal;
      const requestOptions =
        activeSignal === options?.signal ? options : { ...options, signal: activeSignal };
      const transport = options?.transport || "auto";
      const websocketDisabledForSession =
        transport === "auto" && isWebSocketSseFallbackActive(options?.sessionId);
      if (websocketDisabledForSession) {
        transportAccounting.observeFallback({
          fromTransport: "native-codex-websocket",
          toTransport: "native-codex-sse",
          reason: "policy",
        });
        activeTransport = "native-codex-sse";
        sseStartsAfterFallback = true;
      }

      if (transport !== "sse" && !websocketDisabledForSession) {
        const websocketHeaders = buildWebSocketHeaders(
          modelHeaders,
          optionHeaders,
          accountId,
          apiKey,
          {
            requestId,
            sessionId: sessionId ?? requestId,
            threadId,
          },
        );
        let websocketVisibleOutput = false;
        let websocketStreamStartEmitted = false;
        let websocketConnected = false;
        let websocketSubmitted = false;
        let websocketRetryCount = 0;
        const maxWebSocketRetries = options?.maxRetries ?? DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES;
        while (true) {
          websocketConnected = false;
          websocketSubmitted = false;
          routePhaseSubmitted = false;
          routePhaseZeroSubmissionObserved = false;
          routePhaseSubmissionUnverified = false;
          try {
            await processWebSocketStream(
              resolveCodexWebSocketUrl(model.baseUrl),
              body,
              websocketHeaders,
              output,
              stream,
              model,
              () => {
                if (websocketStreamStartEmitted) {
                  return false;
                }
                websocketStreamStartEmitted = true;
                return true;
              },
              () => {
                websocketVisibleOutput = true;
              },
              () => {
                websocketConnected = true;
              },
              () => {
                websocketSubmitted = true;
                routePhaseSubmitted = true;
              },
              transportAccounting,
              websocketRetryCount > 0 ? "retry" : "initial",
              websocketRetryCount > 0 ? "reconnect" : "initial",
              options?.signal,
              requestOptions,
              firstEventAbort.abort,
              observePromptEgress,
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
            const requestAborted = activeSignal?.aborted;
            const callerAborted = options?.signal?.aborted === true;
            const unsupported = isWebSocketTransportUnavailableError(error);
            const handshakeStatus = readWebSocketHandshakeStatus(error);
            const unsupportedHandshake = handshakeStatus === 426;
            const deterministicResponseFailure = isDeterministicResponsesStreamFailure(error);
            const submissionUnverified = error instanceof WebSocketSubmissionUnverifiedError;
            const sessionClosedDuringRequest =
              sessionLifecycleId !== undefined &&
              websocketRequestSessionEpoch?.generation !== websocketRequestSessionGeneration;
            routePhaseSubmissionUnverified = submissionUnverified;
            if (
              !websocketSubmitted &&
              !unsupported &&
              !submissionUnverified &&
              !routePhaseZeroSubmissionObserved
            ) {
              routePhaseZeroSubmissionObserved = true;
              transportAccounting.observeZeroSubmission({
                transport: "native-codex-websocket",
                outcome: callerAborted ? "aborted" : "failed",
              });
            }
            const canRetry =
              !requestAborted &&
              !sessionClosedDuringRequest &&
              !websocketVisibleOutput &&
              !unsupported &&
              !unsupportedHandshake &&
              !deterministicResponseFailure &&
              !submissionUnverified &&
              websocketRetryCount < maxWebSocketRetries &&
              isRetryableWebSocketFailure(error);
            if (canRetry) {
              const delayMs = WEBSOCKET_BASE_DELAY_MS * 2 ** websocketRetryCount;
              websocketRetryCount += 1;
              routePhaseSubmitted = false;
              routePhaseZeroSubmissionObserved = false;
              await sleepWithAbort(delayMs, activeSignal);
              continue;
            }
            if (requestAborted) {
              throw error;
            }
            const connectionFailure = !websocketConnected && !unsupported && !unsupportedHandshake;
            const submissionFailure = error instanceof WebSocketSubmissionError;
            const streamFailure = websocketSubmitted && !websocketVisibleOutput;
            const canFallbackWithoutVisibleOutput =
              transport === "auto" &&
              !sessionClosedDuringRequest &&
              !websocketVisibleOutput &&
              !deterministicResponseFailure &&
              !submissionUnverified &&
              (unsupported ||
                unsupportedHandshake ||
                connectionFailure ||
                submissionFailure ||
                streamFailure);
            if (!canFallbackWithoutVisibleOutput) {
              throw error;
            }
            appendAssistantMessageDiagnostic(
              output,
              createAssistantMessageDiagnostic("provider_transport_failure", error, {
                configuredTransport: transport,
                fallbackTransport: "sse",
                eventsEmitted: websocketVisibleOutput,
                phase: websocketVisibleOutput
                  ? "after_message_stream_start"
                  : "before_message_stream_start",
                requestBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
              }),
            );
            if (transport === "auto" && options?.sessionId) {
              websocketSseFallbackSessions.add(options.sessionId);
            }
            transportAccounting.observeFallback({
              fromTransport: "native-codex-websocket",
              toTransport: "native-codex-sse",
              reason:
                unsupported || unsupportedHandshake
                  ? "unsupported"
                  : submissionFailure
                    ? "submission_failure"
                    : streamFailure
                      ? "stream_failure"
                      : "connection_failure",
            });
            activeTransport = "native-codex-sse";
            routePhaseSubmitted = false;
            routePhaseZeroSubmissionObserved = false;
            routePhaseSubmissionUnverified = false;
            sseStartsAfterFallback = true;
            break;
          }
        }
      }

      const sseHeaders = buildSSEHeaders(modelHeaders, optionHeaders, accountId, apiKey, {
        requestId,
        sessionId: sessionId ?? requestId,
        threadId,
      });
      const bodyJson = JSON.stringify(body);
      const canCompressSseBody = model.provider === "openai" && !sseHeaders.has("content-encoding");
      const compressedBody = canCompressSseBody ? compressRequestBodyZstd(bodyJson) : null;
      if (compressedBody) {
        sseHeaders.set("content-encoding", "zstd");
      }
      const sseBody: BodyInit = compressedBody ?? bodyJson;
      let onSseFetchDispatch: (() => void) | undefined;
      const guardedSseFetch = buildGuardedModelFetchResult(model, undefined, {
        onFetchDispatch: () => onSseFetchDispatch?.(),
      });
      sseSubmissionAttested = guardedSseFetch.provenance === "dispatch_attested";
      const sseFetch = guardedSseFetch.fetch;

      // Fetch with retry logic for rate limits and transient errors
      let response: Response | undefined;
      let lastError: Error | undefined;
      let pendingSseAttempt: ModelTransportAttemptAuthority | undefined;
      const maxRetries = options?.maxRetries ?? DEFAULT_REQUEST_MAX_RETRIES;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        routePhaseSubmitted = false;
        routePhaseZeroSubmissionObserved = false;
        routePhaseSubmissionUnverified = false;
        if (activeSignal?.aborted) {
          throw transportAbortError(activeSignal);
        }

        let attemptResponse: Response;
        let errorText: string;
        let attemptAuthority: ModelTransportAttemptAuthority | undefined;
        onSseFetchDispatch = () => {
          if (guardedSseFetch.provenance !== "dispatch_attested" || attemptAuthority) {
            return;
          }
          const pendingAttempt = transportAccounting.startAttempt({
            transport: "native-codex-sse",
            reason:
              attempt === 0 ? (sseStartsAfterFallback ? "transport_fallback" : "initial") : "retry",
          });
          attemptAuthority = createModelTransportAttemptAuthority({
            events: transportAccounting,
            pendingAttempt,
            requestedModel: model.id,
            transport: "native-codex-sse",
          });
          routePhaseSubmitted = true;
        };
        try {
          observePromptEgress?.(body, {
            egress: "native-codex-sse",
            payloadVariant: "initial",
          });
          const responsePromise = sseFetch(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers: sseHeaders,
            body: sseBody,
            signal: activeSignal,
            // The OpenClaw host owns guarded redirect replay. Hostless consumers
            // retain ambient redirect behavior, but remain explicitly uninstrumented.
            ...(guardedSseFetch.provenance === "dispatch_attested"
              ? { redirect: "manual" as const }
              : {}),
          });
          attemptResponse = await responsePromise;
          response = attemptResponse;
          attemptAuthority?.observeServingModel(
            attemptResponse.headers.get("openai-model") ??
              attemptResponse.headers.get("x-openai-model"),
          );
          if (attemptResponse.ok) {
            pendingSseAttempt = attemptAuthority;
          } else {
            attemptAuthority?.finish("failed", attemptResponse.status);
          }
          await options?.onResponse?.(
            { status: attemptResponse.status, headers: headersToRecord(attemptResponse.headers) },
            model,
          );

          if (attemptResponse.ok) {
            break;
          }
          errorText = await readChatGptResponsesErrorTextLimited(attemptResponse);
        } catch (error) {
          if (!attemptAuthority && sseSubmissionAttested) {
            routePhaseZeroSubmissionObserved = true;
            transportAccounting.observeZeroSubmission({
              transport: "native-codex-sse",
              outcome: options?.signal?.aborted ? "aborted" : "failed",
            });
          }
          attemptAuthority?.finish(options?.signal?.aborted ? "aborted" : "failed");
          if (pendingSseAttempt === attemptAuthority) {
            pendingSseAttempt = undefined;
          }
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
          const tlsCertificateError = inspectTlsCertificateError(error);
          lastError = toErrorObject(error, String(error));
          // Deterministic certificate failures cannot recover through backoff.
          if (
            attempt < maxRetries &&
            !lastError.message.includes("usage limit") &&
            !tlsCertificateError
          ) {
            routePhaseSubmitted = false;
            routePhaseZeroSubmissionObserved = false;
            const delayMs = BASE_DELAY_MS * 2 ** attempt;
            await sleepWithAbort(delayMs, activeSignal);
            continue;
          }
          throw lastError;
        } finally {
          onSseFetchDispatch = undefined;
        }

        if (attempt < maxRetries && isRetryableError(attemptResponse.status, errorText)) {
          routePhaseSubmitted = false;
          routePhaseZeroSubmissionObserved = false;
          await sleepWithAbort(resolveHttpRetryDelayMs(attemptResponse, attempt), activeSignal);
          continue;
        }

        const info = parseErrorResponseText(
          errorText,
          attemptResponse.status,
          attemptResponse.statusText,
        );
        throw new Error(info.friendlyMessage || info.message);
      }

      try {
        if (!response?.ok) {
          throw lastError ?? new Error("Failed after retries");
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        stream.push({ type: "start", partial: output });
        await processStream(
          response,
          output,
          stream,
          model,
          options,
          firstEventAbort.abort,
          pendingSseAttempt,
        );

        if (activeSignal?.aborted) {
          throw transportAbortError(activeSignal);
        }

        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error(output.errorMessage ?? "An unknown error occurred");
        }
        pendingSseAttempt?.finish("completed", response.status);
      } catch (error) {
        pendingSseAttempt?.finish(
          options?.signal?.aborted ? "aborted" : "failed",
          response?.status,
        );
        throw error;
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      if (
        !routePhaseSubmitted &&
        !routePhaseZeroSubmissionObserved &&
        !routePhaseSubmissionUnverified &&
        (activeTransport !== "native-codex-sse" || sseSubmissionAttested)
      ) {
        transportAccounting.observeZeroSubmission({
          transport: activeTransport,
          outcome: options?.signal?.aborted ? "aborted" : "failed",
        });
      }
      const normalizedError =
        isRequestTimeoutError(error, options?.signal, requestTimeoutSignal, requestTimeoutMs) &&
        requestTimeoutMs !== undefined
          ? formatRequestTimeoutError(requestTimeoutMs, error)
          : error;
      for (const block of output.content) {
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        normalizedError instanceof Error ? normalizedError.message : String(normalizedError);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      firstEventAbort?.dispose();
      if (websocketSessionEpochLease) {
        releaseWebSocketSessionEpoch(
          websocketSessionEpochLease.sessionId,
          websocketSessionEpochLease.epoch,
        );
      }
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
    requestId: options?.requestId,
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
): RequestBody {
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    replayResponsesItemIds: false,
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
    const converted = convertResponsesToolPayload(context.tools, { strict: null });
    if (converted.tools.length > 0) {
      body.tools = converted.tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
  }

  if (options?.reasoningEffort !== undefined) {
    const effort =
      options.reasoningEffort === "none"
        ? (model.thinkingLevelMap?.off ?? "none")
        : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
    if (effort !== null) {
      body.reasoning = {
        effort,
        summary: options.reasoningSummary ?? "auto",
      };
    }
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

async function processStream(
  response: Response,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-chatgpt-responses">,
  options?: OpenAICodexResponsesOptions,
  abortFirstEventStream?: (reason: Error) => void,
  attemptAuthority?: ModelTransportAttemptAuthority,
): Promise<void> {
  await processResponsesStream(
    mapCodexEvents(parseSSE(response), (servingModel) =>
      attemptAuthority?.observeServingModel(servingModel),
    ),
    output,
    stream,
    model,
    {
      serviceTier: options?.serviceTier,
      firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
      abortFirstEventStream,
      onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
      signal: options?.signal,
      resolveServiceTier: resolveCodexServiceTier,
      resolveResponseModel: () => attemptAuthority?.readServingModel(),
      applyServiceTierPricing: (usage, serviceTier) =>
        applyResponsesServiceTierPricing(usage, serviceTier, model),
    },
  );
}

class CodexApiError extends Error {
  readonly code?: string;
  readonly payload?: Record<string, unknown>;

  constructor(
    message: string,
    options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message);
    this.name = "CodexApiError";
    this.code = options?.code;
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

class CodexProtocolError extends Error {
  readonly payload?: unknown;

  constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
    super(message);
    this.name = "CodexProtocolError";
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
  return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

const DETERMINISTIC_RESPONSES_FAILURE_CODES = new Set([
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_prompt",
  "server_is_overloaded",
  "slow_down",
  "usage_limit_reached",
  "usage_not_included",
  "workspace_member_usage_limit_reached",
  "workspace_owner_usage_limit_reached",
]);

function isDeterministicResponsesStreamFailure(error: unknown): boolean {
  if (!(error instanceof ResponsesStreamFailure)) {
    return false;
  }
  const response =
    error.response && typeof error.response === "object"
      ? (error.response as Record<string, unknown>)
      : undefined;
  const failure =
    response?.error && typeof response.error === "object"
      ? (response.error as Record<string, unknown>)
      : undefined;
  const code = typeof failure?.code === "string" ? failure.code : undefined;
  const errorType = typeof failure?.type === "string" ? failure.type : undefined;
  return (
    (code !== undefined && DETERMINISTIC_RESPONSES_FAILURE_CODES.has(code)) ||
    (errorType !== undefined && DETERMINISTIC_RESPONSES_FAILURE_CODES.has(errorType))
  );
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
  observeServingModel?: (model: unknown) => void,
): AsyncGenerator<ResponseStreamEvent> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) {
      continue;
    }
    observeServingModel?.(resolveCodexEventServingModel(event));

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

function readCodexModelHeader(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "openai-model" || normalizedName === "x-openai-model") {
      if (typeof headerValue === "string") {
        return headerValue;
      }
      if (Array.isArray(headerValue) && typeof headerValue[0] === "string") {
        return headerValue[0];
      }
    }
  }
  return undefined;
}

function resolveCodexEventServingModel(event: Record<string, unknown>): string | undefined {
  const response =
    event.response && typeof event.response === "object" && !Array.isArray(event.response)
      ? (event.response as Record<string, unknown>)
      : undefined;
  return readCodexModelHeader(response?.headers) ?? readCodexModelHeader(event.headers);
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
// SSE Parsing
// ============================================================================

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  // Cap the streaming 200 success-body read at 16 MiB, mirroring the
  // non-streaming `readProviderJsonResponse` cap so a hostile or
  // malfunctioning ChatGPT Responses endpoint cannot exhaust memory by
  // streaming an unbounded SSE body.
  const guard = createSseByteGuard(reader, {
    maxBytes: OPENAI_CHATGPT_RESPONSES_SUCCESS_BODY_MAX_BYTES,
    onOverflow: ({ size, maxBytes }) =>
      new Error(
        `OpenAI ChatGPT Responses success body exceeded ${maxBytes} bytes (received ${size})`,
      ),
  });
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await guard.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        buffer += decoder.decode();
      }

      while (true) {
        // Defer a possible CRLF only when CR does not already complete a blank line.
        const deferTrailingCr =
          !done && buffer.endsWith("\r") && !buffer.endsWith("\r\r") && !buffer.endsWith("\n\r");
        const searchable = deferTrailingCr ? buffer.slice(0, -1) : buffer;
        // A CRLF is one line ending: never backtrack its CR into a false blank line.
        const boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(searchable);
        if (!boundary) {
          break;
        }
        const chunk = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);

        const dataLines = chunk
          .split(/\r\n|\r|\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch (cause) {
              if (!(cause instanceof SyntaxError)) {
                throw cause;
              }
              // Align with the canonical transport contract: the shared marker is what
              // assistant error formatting maps to the malformed-fragment retry copy.
              throw new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause });
            }
            // Keep suspension outside the parse catch so iterator.throw() cannot relabel a
            // consumer failure as malformed provider input.
            yield event;
          }
        }
      }

      if (done) {
        break;
      }
    }
  } finally {
    try {
      await guard.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}

// Test-only re-export of the bounded SSE parser. Mirrors
// `parseAnthropicSseBodyForTest` / `iterateSseMessagesForTest` patterns.
export const parseSSEForTest = parseSSE;

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;
type WebSocketNodeListener = {
  (type: "upgrade", listener: (response: { headers?: unknown }) => void): void;
  (
    type: "unexpected-response",
    listener: (_request: unknown, response: { resume(): void; statusCode?: number }) => void,
  ): void;
};

interface WebSocketBase {
  readonly bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  on?: WebSocketNodeListener;
  off?: WebSocketNodeListener;
}

interface ReturnWebSocketLike extends WebSocketBase {
  send(data: string): void;
}

interface CallbackWebSocketLike extends WebSocketBase {
  send(data: string, callback: (error?: Error) => void): void;
  terminate?(): void;
}

type WebSocketConnection =
  | {
      socket: CallbackWebSocketLike;
      submissionAuthority: "callback";
      dispose?: () => void;
    }
  | {
      socket: ReturnWebSocketLike;
      submissionAuthority: "return";
      dispose?: () => void;
    };

type WebSocketLike = ReturnWebSocketLike | CallbackWebSocketLike;

interface CachedWebSocketContinuationState {
  lastRequestBody: RequestBody;
  lastResponseId: string;
  lastResponseItems: ResponseInput;
}

type CachedWebSocketConnection = WebSocketConnection & {
  busy: boolean;
  createdAt: number;
  endpointAuthority: "complete" | "partial";
  handshakeServingModel?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuationState;
};

type AcquiredWebSocketConnection = WebSocketConnection & {
  entry?: CachedWebSocketConnection;
  endpointAuthority: "complete" | "partial";
  handshakeServingModel?: string;
  release: (options?: { keep?: boolean }) => void;
};

type WebSocketConstructor<T extends WebSocketLike = WebSocketLike> = new (
  url: string,
  protocols?:
    | string
    | string[]
    | {
        headers?: Record<string, string>;
        maxBufferedChunks?: number;
        maxFragments?: number;
        maxPayload?: number;
        perMessageDeflate?: boolean;
      },
) => T;

type WebSocketRuntime =
  | {
      constructor: WebSocketConstructor<CallbackWebSocketLike>;
      endpointAuthority: "complete";
      submissionAuthority: "callback";
    }
  | {
      constructor: WebSocketConstructor<ReturnWebSocketLike>;
      endpointAuthority: "partial";
      submissionAuthority: "return";
    };

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketSseFallbackSessions = new Set<string>();
type WebSocketSessionEpoch = {
  activeRequests: number;
  generation: number;
};
const websocketSessionEpochs = new Map<string, WebSocketSessionEpoch>();
let websocketCacheGeneration = 0;
let cachedWebsocketRuntime: WebSocketRuntime | undefined;

function retainWebSocketSessionEpoch(sessionId: string): WebSocketSessionEpoch {
  let epoch = websocketSessionEpochs.get(sessionId);
  if (!epoch) {
    epoch = { activeRequests: 0, generation: 0 };
    websocketSessionEpochs.set(sessionId, epoch);
  }
  epoch.activeRequests += 1;
  return epoch;
}

function releaseWebSocketSessionEpoch(sessionId: string, epoch: WebSocketSessionEpoch): void {
  epoch.activeRequests -= 1;
  if (epoch.activeRequests === 0 && websocketSessionEpochs.get(sessionId) === epoch) {
    websocketSessionEpochs.delete(sessionId);
  }
}

export function resetOpenAICodexWebSocketStateForTest(): void {
  cachedWebsocketRuntime = undefined;
  websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
  const closeEntry = (entry: CachedWebSocketConnection) => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    disposeWebSocketConnection(entry, 1000, "debug_close");
  };
  // Sticky SSE fallback follows the provider session-resource lifecycle;
  // otherwise reused session ids stay degraded and the set grows indefinitely.
  if (sessionId) {
    const epoch = websocketSessionEpochs.get(sessionId);
    if (epoch) {
      epoch.generation += 1;
    }
    websocketSseFallbackSessions.delete(sessionId);
    const entry = websocketSessionCache.get(sessionId);
    if (entry) {
      closeEntry(entry);
    }
    websocketSessionCache.delete(sessionId);
    return;
  }
  websocketCacheGeneration += 1;
  for (const epoch of websocketSessionEpochs.values()) {
    epoch.generation += 1;
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

async function getWebSocketRuntime(): Promise<WebSocketRuntime | undefined> {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    if (typeof ctor !== "function") {
      return undefined;
    }
    if (cachedWebsocketRuntime?.constructor === ctor) {
      return cachedWebsocketRuntime;
    }
    cachedWebsocketRuntime = {
      constructor: ctor as unknown as WebSocketConstructor<ReturnWebSocketLike>,
      endpointAuthority: "partial",
      submissionAuthority: "return",
    };
    return cachedWebsocketRuntime;
  }

  if (cachedWebsocketRuntime?.endpointAuthority === "complete") {
    return cachedWebsocketRuntime;
  }
  const imported = (await import("ws")) as {
    WebSocket?: WebSocketConstructor<CallbackWebSocketLike>;
    default?: WebSocketConstructor<CallbackWebSocketLike>;
  };
  const nodeWebSocket = imported.WebSocket ?? imported.default;
  if (typeof nodeWebSocket !== "function") {
    return undefined;
  }
  cachedWebsocketRuntime = {
    constructor: nodeWebSocket,
    endpointAuthority: "complete",
    submissionAuthority: "callback",
  };
  return cachedWebsocketRuntime;
}

function isWebSocketTransportUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "WebSocket transport is not available in this runtime"
  );
}

function readWebSocketHandshakeStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
  ) {
    return statusCode;
  }
  return readWebSocketHandshakeStatus((error as { cause?: unknown }).cause);
}

class WebSocketCloseError extends Error {
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;

  constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
    super(message);
    this.name = "WebSocketCloseError";
    this.code = options?.code;
    this.reason = options?.reason;
    this.wasClean = options?.wasClean;
  }
}

class WebSocketSessionClosedError extends Error {
  constructor() {
    super("WebSocket session was closed while a connection was opening");
    this.name = "WebSocketSessionClosedError";
  }
}

function isRetryableWebSocketFailure(error: unknown): boolean {
  if (
    error instanceof WebSocketSessionClosedError ||
    error instanceof WebSocketSubmissionUnverifiedError ||
    inspectTlsCertificateError(error)
  ) {
    return false;
  }
  const handshakeStatus = readWebSocketHandshakeStatus(error);
  if (handshakeStatus !== undefined) {
    return [408, 425, 429, 500, 502, 503, 504].includes(handshakeStatus);
  }
  if (error instanceof CodexApiError) {
    return (
      isWebSocketConnectionLimitReachedError(error) ||
      /^(?:internal_server_error|request_timeout|response_stream_failed|server_error|service_unavailable|timeout)$/i.test(
        error.code ?? "",
      )
    );
  }
  if (error instanceof WebSocketCloseError) {
    return (
      error.code !== WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE &&
      !(error.code === 1000 && error.wasClean === true)
    );
  }
  if (error instanceof WebSocketSubmissionError) {
    return true;
  }
  if (error instanceof ResponsesStreamFailure) {
    return !isDeterministicResponsesStreamFailure(error);
  }
  if (error instanceof CodexProtocolError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return !(
    (error instanceof TypeError && /bigint|circular|serializ/i.test(message)) ||
    /usage limit|unauthori[sz]ed|forbidden|invalid (?:request|api key)|authentication/i.test(
      message,
    )
  );
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

function disposeWebSocketConnection(
  connection: WebSocketConnection,
  code = 1000,
  reason = "done",
): void {
  if (connection.dispose) {
    connection.dispose();
    return;
  }
  closeWebSocketSilently(connection.socket, code, reason);
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
    disposeWebSocketConnection(entry, 1000, "idle_timeout");
    deleteOwnedWebSocketSession(sessionId, entry);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

async function connectWebSocket(
  model: Model<"openai-chatgpt-responses">,
  url: string,
  headers: Headers,
  transportAccounting: ModelTransportEventScope,
  connectionReason: ModelTransportConnectionReason,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
  timeoutMs?: number,
): Promise<
  WebSocketConnection & {
    endpointAuthority: "complete" | "partial";
    handshakeServingModel?: string;
  }
> {
  const wsHeaders = headersToRecord(headers);
  delete wsHeaders["OpenAI-Beta"];

  const pendingConnection = transportAccounting.startConnection({
    transport: "native-codex-websocket",
    reason: connectionReason,
  });
  try {
    const hostConnector = getAiTransportHost().connectModelWebSocket;
    if (hostConnector) {
      const hostResource = await hostConnector(model, {
        url,
        headers: wsHeaders,
        ...(signal ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      if (!hostResource) {
        throw new Error("WebSocket transport is not available in this runtime");
      }
      pendingConnection.finish("completed");
      return {
        socket: hostResource.socket as AiModelWebSocket as CallbackWebSocketLike,
        endpointAuthority: "complete",
        submissionAuthority: "callback",
        handshakeServingModel: readCodexModelHeader(hostResource.handshakeHeaders),
        dispose: () => hostResource.dispose(),
      };
    }

    const websocketRuntime = await getWebSocketRuntime();
    if (!websocketRuntime) {
      throw new Error("WebSocket transport is not available in this runtime");
    }
    const WebSocketCtor = websocketRuntime.constructor;
    const connection = await new Promise<
      WebSocketConnection & {
        endpointAuthority: "complete" | "partial";
        handshakeServingModel?: string;
      }
    >((resolve, reject) => {
      let settled = false;
      let createdSocket: WebSocketLike;
      const endpointAuthority = websocketRuntime.endpointAuthority;
      const submissionAuthority = websocketRuntime.submissionAuthority;
      let handshakeServingModel: string | undefined;
      const onUpgrade = (response: { headers?: unknown }) => {
        handshakeServingModel = readCodexModelHeader(response.headers);
      };

      try {
        createdSocket = new WebSocketCtor(url, {
          headers: wsHeaders,
          maxBufferedChunks: WEBSOCKET_MAX_BUFFERED_CHUNKS,
          maxFragments: WEBSOCKET_MAX_FRAGMENTS,
          maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES,
          perMessageDeflate: true,
        });
        if (endpointAuthority === "complete") {
          createdSocket.on?.("upgrade", onUpgrade);
        }
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
        const authority = handshakeServingModel ? { handshakeServingModel } : {};
        if (submissionAuthority === "callback") {
          resolve({
            socket: createdSocket as CallbackWebSocketLike,
            endpointAuthority,
            submissionAuthority,
            ...authority,
          });
        } else {
          resolve({
            socket: createdSocket as ReturnWebSocketLike,
            endpointAuthority,
            submissionAuthority,
            ...authority,
          });
        }
      };
      const onError: WebSocketListener = (event) => {
        const error = extractWebSocketError(event);
        if (settled) {
          cleanup();
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onClose: WebSocketListener = (event) => {
        const error = extractWebSocketCloseError(event);
        if (settled) {
          cleanup();
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onUnexpectedResponse = (
        _request: unknown,
        response: { resume(): void; statusCode?: number },
      ) => {
        response.resume();
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new WebSocketHandshakeError(response.statusCode ?? 500));
      };
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        createdSocket.close(1000, "aborted");
        reject(new Error("Request was aborted"));
      };

      const cleanup = () => {
        createdSocket.off?.("upgrade", onUpgrade);
        createdSocket.off?.("unexpected-response", onUnexpectedResponse);
        createdSocket.removeEventListener("open", onOpen);
        createdSocket.removeEventListener("error", onError);
        createdSocket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      createdSocket.addEventListener("open", onOpen);
      createdSocket.addEventListener("error", onError);
      createdSocket.addEventListener("close", onClose);
      if (endpointAuthority === "complete") {
        createdSocket.on?.("unexpected-response", onUnexpectedResponse);
      }
      signal?.addEventListener("abort", onAbort);
    });
    pendingConnection.finish("completed");
    return connection;
  } catch (error) {
    pendingConnection.finish(callerSignal?.aborted ? "aborted" : "failed");
    throw error;
  }
}

async function acquireWebSocket(
  model: Model<"openai-chatgpt-responses">,
  url: string,
  headers: Headers,
  sessionId: string | undefined,
  transportAccounting: ModelTransportEventScope,
  connectionReason: ModelTransportConnectionReason,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
  timeoutMs?: number,
): Promise<AcquiredWebSocketConnection> {
  const cacheGeneration = websocketCacheGeneration;
  const sessionEpoch = sessionId ? websocketSessionEpochs.get(sessionId) : undefined;
  const sessionGeneration = sessionEpoch?.generation;
  const assertAcquireStillCurrent = (connection: WebSocketConnection) => {
    const sessionChanged =
      sessionEpoch !== undefined && sessionEpoch.generation !== sessionGeneration;
    if (websocketCacheGeneration !== cacheGeneration || sessionChanged) {
      disposeWebSocketConnection(connection, 1000, "session_closed");
      throw new WebSocketSessionClosedError();
    }
  };
  if (!sessionId) {
    const connection = await connectWebSocket(
      model,
      url,
      headers,
      transportAccounting,
      connectionReason,
      signal,
      callerSignal,
      timeoutMs,
    );
    assertAcquireStillCurrent(connection);
    return {
      ...connection,
      release: () => {
        disposeWebSocketConnection(connection);
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
      disposeWebSocketConnection(cached, 1000, "connection_age_limit");
      deleteOwnedWebSocketSession(sessionId, cached);
      expectedCacheValue = undefined;
    } else if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        ...cached,
        entry: cached,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(cached.socket)) {
            disposeWebSocketConnection(cached);
            deleteOwnedWebSocketSession(sessionId, cached);
            return;
          }
          cached.busy = false;
          scheduleSessionWebSocketExpiry(sessionId, cached);
        },
      };
    }
    if (cached.busy) {
      const connection = await connectWebSocket(
        model,
        url,
        headers,
        transportAccounting,
        connectionReason,
        signal,
        callerSignal,
        timeoutMs,
      );
      assertAcquireStillCurrent(connection);
      return {
        ...connection,
        release: () => {
          disposeWebSocketConnection(connection);
        },
      };
    }
    if (!isWebSocketReusable(cached.socket)) {
      disposeWebSocketConnection(cached);
      deleteOwnedWebSocketSession(sessionId, cached);
      expectedCacheValue = undefined;
    }
  }

  const connection = await connectWebSocket(
    model,
    url,
    headers,
    transportAccounting,
    connectionReason,
    signal,
    callerSignal,
    timeoutMs,
  );
  assertAcquireStillCurrent(connection);
  const entry: CachedWebSocketConnection = {
    ...connection,
    busy: true,
    createdAt: Date.now(),
  };
  // Install only if the cache still matches what this acquire left behind (the
  // stale entry it removed, or empty for a first connect). A different cached
  // entry means a concurrent request already won this session during the await;
  // let it keep the lease and leave this socket transient.
  const ownsCache = setOwnedWebSocketSession(sessionId, entry, expectedCacheValue);
  return {
    ...connection,
    entry: ownsCache ? entry : undefined,
    release: ({ keep } = {}) => {
      if (!ownsCache || !keep || !isWebSocketReusable(entry.socket)) {
        disposeWebSocketConnection(entry);
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
    if (typeof message === "string" && message.length > 0) {
      return new Error(message);
    }

    const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
    if (nestedError instanceof Error && nestedError.message.length > 0) {
      return nestedError;
    }
    if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
      const nestedMessage = (nestedError as { message?: unknown }).message;
      if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
        return new Error(nestedMessage);
      }
    }
  }
  return new Error("WebSocket error");
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
    return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
      code: typeof code === "number" ? code : undefined,
      reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
      wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
    });
  }
  return new Error("WebSocket closed");
}

function createWebSocketEventStream(
  socket: WebSocketLike,
  signal?: AbortSignal,
): {
  dispose(): void;
  events: AsyncIterable<Record<string, unknown>>;
  firstValidEvent: Promise<void>;
} {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let disposed = false;
  let failed: Error | null = null;
  let sawCompletion = false;
  let resolveFirstValidEvent: (() => void) | undefined;
  const firstValidEvent = new Promise<void>((resolve) => {
    resolveFirstValidEvent = resolve;
  });

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
      resolveFirstValidEvent?.();
      resolveFirstValidEvent = undefined;
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

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    done = true;
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
    wake();
  };

  const events = (async function* (): AsyncGenerator<Record<string, unknown>> {
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
      dispose();
    }
  })();

  return { dispose, events, firstValidEvent };
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
  onStart: () => boolean,
): AsyncGenerator<ResponseStreamEvent> {
  let started = false;
  for await (const event of events) {
    if (!started) {
      started = true;
      if (onStart()) {
        stream.push({ type: "start", partial: output });
      }
    }
    yield event;
  }
}

function isWebSocketVisibleOutputEvent(event: { type?: string }): boolean {
  return (
    event.type === "response.content_part.added" ||
    event.type === "response.function_call_arguments.delta" ||
    event.type === "response.function_call_arguments.done" ||
    event.type === "response.output_item.added" ||
    event.type === "response.output_item.done" ||
    event.type === "response.output_text.delta" ||
    event.type === "response.reasoning_summary_part.added" ||
    event.type === "response.reasoning_summary_part.done" ||
    event.type === "response.reasoning_summary_text.delta" ||
    event.type === "response.reasoning_text.delta" ||
    event.type === "response.refusal.delta"
  );
}

class WebSocketSubmissionError extends Error {
  constructor(cause: Error) {
    super(`WebSocket submission failed: ${cause.message}`, { cause });
    this.name = "WebSocketSubmissionError";
  }
}

class WebSocketSubmissionUnverifiedError extends Error {
  constructor(cause: Error) {
    super(`WebSocket submission outcome is unverified: ${cause.message}`, { cause });
    this.name = "WebSocketSubmissionUnverifiedError";
  }
}

class WebSocketHandshakeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Unexpected server response: ${statusCode}`);
    this.name = "WebSocketHandshakeError";
    this.statusCode = statusCode;
  }
}

async function submitWebSocketFrame(
  connection: WebSocketConnection,
  frame: string,
  signal?: AbortSignal,
  providerAdmission?: Promise<void>,
  onAdmitted?: () => void,
): Promise<void> {
  if (signal?.aborted) {
    throw transportAbortError(signal);
  }
  if (
    (connection.socket.bufferedAmount ?? 0) + new TextEncoder().encode(frame).byteLength >
    WEBSOCKET_MAX_BUFFERED_BYTES
  ) {
    throw new WebSocketSubmissionError(
      new Error("WebSocket buffered payload limit exceeded before submission"),
    );
  }
  if (connection.submissionAuthority === "return") {
    try {
      connection.socket.send(frame);
    } catch (error) {
      throw new WebSocketSubmissionUnverifiedError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    onAdmitted?.();
    return;
  }

  const socket = connection.socket;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onError: WebSocketListener = (event) => {
      finish(new WebSocketSubmissionUnverifiedError(extractWebSocketError(event)));
    };
    const onClose: WebSocketListener = (event) => {
      finish(new WebSocketSubmissionUnverifiedError(extractWebSocketCloseError(event)));
    };
    const onAbort = () => {
      try {
        socket.terminate?.();
      } catch {}
      finish(new WebSocketSubmissionUnverifiedError(transportAbortError(signal)));
    };
    void providerAdmission?.then(
      () => finish(),
      () => {},
    );
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      socket.send(frame, (error) => {
        if (error) {
          finish(new WebSocketSubmissionUnverifiedError(error));
          return;
        }
        finish();
      });
    } catch (error) {
      finish(
        new WebSocketSubmissionError(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });
  onAdmitted?.();
}

function observeWebSocketAuthorityCoverage(params: {
  endpointAuthority: "complete" | "partial";
  submissionUnverified?: boolean;
  submissionAuthority: "callback" | "return";
  transportAccounting: ModelTransportEventScope;
}): void {
  if (params.endpointAuthority === "partial") {
    params.transportAccounting.observeCoverage({
      transport: "native-codex-websocket",
      scope: "transport_semantics",
      state: "unverified",
      reason: "transport_endpoint_authority_partial",
    });
  }
  if (params.submissionAuthority === "return" || params.submissionUnverified === true) {
    params.transportAccounting.observeCoverage({
      transport: "native-codex-websocket",
      scope: "transport_semantics",
      state: "unverified",
      reason: "transport_submission_authority_partial",
    });
  }
}

async function processWebSocketStream(
  url: string,
  body: RequestBody,
  headers: Headers,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-chatgpt-responses">,
  onStart: () => boolean,
  onVisibleOutput: () => void,
  onConnected: () => void,
  onSubmitted: () => void,
  transportAccounting: ModelTransportEventScope,
  attemptReason: "initial" | "retry",
  connectionReason: ModelTransportConnectionReason,
  callerSignal: AbortSignal | undefined,
  options?: OpenAICodexResponsesOptions,
  abortFirstEventStream?: (reason: Error) => void,
  observePromptEgress?: ObserveResponsesPromptEgress,
): Promise<void> {
  const acquired = await acquireWebSocket(
    model,
    url,
    headers,
    options?.sessionId,
    transportAccounting,
    connectionReason,
    options?.signal,
    callerSignal,
    resolveRequestTimeoutMs(options),
  );
  const { socket, entry, endpointAuthority, submissionAuthority, handshakeServingModel, release } =
    acquired;
  onConnected();
  let keepConnection = true;
  const useCachedContext =
    options?.transport === "websocket-cached" || options?.transport === "auto";
  // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
  // WebSocket continuation still works via connection-scoped previous_response_id state.
  const fullBody = body;
  const requestBody =
    useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
  let attemptAuthority: ModelTransportAttemptAuthority | undefined;
  let responseStream: ReturnType<typeof createWebSocketEventStream> | undefined;
  try {
    if (options?.signal?.aborted) {
      throw transportAbortError(options.signal);
    }
    observePromptEgress?.(requestBody, {
      egress: "native-codex-websocket",
      payloadVariant: "initial",
    });
    const requestFrame = JSON.stringify({ type: "response.create", ...requestBody });
    responseStream = createWebSocketEventStream(socket, options?.signal);
    await submitWebSocketFrame(
      acquired,
      requestFrame,
      options?.signal,
      responseStream.firstValidEvent,
      () => {
        onSubmitted();
        const pendingAttempt = transportAccounting.startAttempt({
          transport: "native-codex-websocket",
          reason: attemptReason,
        });
        attemptAuthority = createModelTransportAttemptAuthority({
          events: transportAccounting,
          pendingAttempt,
          requestedModel: model.id,
          transport: "native-codex-websocket",
        });
        attemptAuthority.observeServingModel(handshakeServingModel);
      },
    );
    const admittedAttempt = attemptAuthority;
    if (!admittedAttempt) {
      throw new Error("WebSocket dispatch completed without an admitted transport attempt");
    }
    await processResponsesStream(
      startWebSocketOutputOnFirstEvent(
        mapCodexEvents(responseStream.events, (servingModel) =>
          admittedAttempt.observeServingModel(servingModel),
        ),
        output,
        stream,
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
        signal: options?.signal,
        onValidatedEvent: (event) => {
          if (isWebSocketVisibleOutputEvent(event)) {
            onVisibleOutput();
          }
        },
        resolveServiceTier: resolveCodexServiceTier,
        resolveResponseModel: () => admittedAttempt.readServingModel(),
        applyServiceTierPricing: (usage, serviceTier) =>
          applyResponsesServiceTierPricing(usage, serviceTier, model),
      },
    );
    if (options?.signal?.aborted) {
      admittedAttempt.finish(callerSignal?.aborted ? "aborted" : "failed");
      keepConnection = false;
    } else {
      admittedAttempt.finish(
        output.stopReason === "aborted"
          ? "aborted"
          : output.stopReason === "error"
            ? "failed"
            : "completed",
      );
      if (useCachedContext && entry && output.responseId) {
        const responseItems = convertResponsesMessages(
          model,
          { messages: [output] },
          CODEX_TOOL_CALL_PROVIDERS,
          {
            includeSystemPrompt: false,
            replayResponsesItemIds: false,
          },
        ).filter((item) => item.type !== "function_call_output");
        entry.continuation = {
          lastRequestBody: fullBody,
          lastResponseId: output.responseId,
          lastResponseItems: responseItems,
        };
      }
    }
  } catch (error) {
    attemptAuthority?.finish(callerSignal?.aborted ? "aborted" : "failed");
    if (!attemptAuthority && error instanceof WebSocketSubmissionUnverifiedError) {
      observeWebSocketAuthorityCoverage({
        endpointAuthority,
        submissionUnverified: true,
        submissionAuthority,
        transportAccounting,
      });
    }
    if (entry) {
      entry.continuation = undefined;
    }
    keepConnection = false;
    throw error;
  } finally {
    if (attemptAuthority) {
      observeWebSocketAuthorityCoverage({
        endpointAuthority,
        submissionAuthority,
        transportAccounting,
      });
    }
    responseStream?.dispose();
    release({ keep: keepConnection });
  }
}

// ============================================================================
// Error Handling
// ============================================================================

async function readChatGptResponsesErrorTextLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let reachedLimit = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
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
    if (reachedLimit) {
      // This provider module is browser-safe, so keep error-body capping on Web APIs.
      await reader.cancel().catch(() => {});
    }
    try {
      reader.releaseLock();
    } catch {}
  }

  return text;
}

function parseErrorResponseText(
  raw: string,
  status: number,
  statusText: string,
): { message: string; friendlyMessage?: string } {
  let message = raw || statusText || "Request failed";
  let friendlyMessage: string | undefined;

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
      const code = err.code || err.type || "";
      if (
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) ||
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

  return { message, friendlyMessage };
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

type CodexRequestIdentity = {
  requestId: string;
  sessionId: string;
  threadId: string;
};

function applyCodexRequestIdentityHeaders(headers: Headers, identity: CodexRequestIdentity): void {
  headers.set("x-client-request-id", identity.threadId);
  headers.set("session-id", identity.sessionId);
  headers.set("thread-id", identity.threadId);
  // Retain the shipped affinity header while adding Codex's canonical names.
  headers.set("session_id", identity.sessionId);
}

function buildSSEHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
  identity: CodexRequestIdentity,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  applyCodexRequestIdentityHeaders(headers, identity);

  return headers;
}

function buildWebSocketHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
  identity: CodexRequestIdentity,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  applyCodexRequestIdentityHeaders(headers, identity);
  return headers;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
