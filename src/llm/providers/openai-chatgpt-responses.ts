import type * as NodeOs from "node:os";
import type {
  Tool as OpenAITool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
let os: typeof NodeOs | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_OS_SPECIFIER = "node:os";

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  void dynamicImport(NODE_OS_SPECIFIER).then((m) => {
    os = m as typeof NodeOs;
  });
}

import {
  resolveTimerTimeoutMs,
  clampTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../model-utils.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "../types.js";
import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  formatThrownValue,
} from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { resolveOpenAICodexAccountId } from "../utils/oauth/openai-chatgpt-jwt.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRY_AFTER_HTTP_DATE_RE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

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

export interface OpenAICodexResponsesOptions extends StreamOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    });
  });
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
    let requestTimeoutMs: number | undefined;
    let activeSignal: AbortSignal | undefined;
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-chatgpt-responses" as Api,
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
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }

      const accountId = extractOpenAICodexAccountId(apiKey);
      let body = buildRequestBody(model, context, options);
      const nextBody = await options?.onPayload?.(body, model);
      if (nextBody !== undefined) {
        body = nextBody as RequestBody;
      }
      const websocketRequestId = options?.sessionId || createCodexRequestId();
      const sseHeaders = buildSSEHeaders(
        model.headers,
        options?.headers,
        accountId,
        apiKey,
        options?.sessionId,
      );
      const websocketHeaders = buildWebSocketHeaders(
        model.headers,
        options?.headers,
        accountId,
        apiKey,
        websocketRequestId,
      );
      const bodyJson = JSON.stringify(body);
      requestTimeoutMs = resolveRequestTimeoutMs(options);
      activeSignal = buildRequestSignal(options?.signal, requestTimeoutMs);
      const requestOptions =
        activeSignal === options?.signal ? options : { ...options, signal: activeSignal };
      const transport = options?.transport || "auto";
      const websocketDisabledForSession =
        transport === "auto" && isWebSocketSseFallbackActive(options?.sessionId);
      if (websocketDisabledForSession) {
        recordWebSocketSseFallback(options?.sessionId);
      }

      if (transport !== "sse" && !websocketDisabledForSession) {
        let websocketStarted = false;
        try {
          await processWebSocketStream(
            resolveCodexWebSocketUrl(model.baseUrl),
            body,
            websocketHeaders,
            output,
            stream,
            model,
            () => {
              websocketStarted = true;
            },
            requestOptions,
          );

          if (activeSignal?.aborted) {
            throw new Error("Request was aborted");
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
          if (aborted || isCodexNonTransportError(error)) {
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
              requestBytes: new TextEncoder().encode(bodyJson).byteLength,
            }),
          );
          recordWebSocketFailure(options?.sessionId, error, {
            activateSseFallback: transport === "auto",
          });
          if (websocketStarted || transport !== "auto") {
            throw error;
          }
          recordWebSocketSseFallback(options?.sessionId);
        }
      }

      // Fetch with retry logic for rate limits and transient errors
      let response: Response | undefined;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (activeSignal?.aborted) {
          throw new Error("Request was aborted");
        }

        try {
          response = await fetch(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers: sseHeaders,
            body: bodyJson,
            signal: activeSignal,
          });
          await options?.onResponse?.(
            { status: response.status, headers: headersToRecord(response.headers) },
            model,
          );

          if (response.ok) {
            break;
          }

          const errorText = await response.text();
          if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
            let delayMs = BASE_DELAY_MS * 2 ** attempt;

            const retryAfterMs = response.headers.get("retry-after-ms");
            if (retryAfterMs !== null) {
              const trimmedRetryAfterMs = retryAfterMs.trim();
              const millis = Number(trimmedRetryAfterMs);
              if (/^\d+(?:\.\d+)?$/.test(trimmedRetryAfterMs) && Number.isFinite(millis)) {
                delayMs = clampTimerTimeoutMs(millis, 0) ?? delayMs;
              }
            } else {
              const retryAfter = response.headers.get("retry-after");
              if (retryAfter) {
                const trimmedRetryAfter = retryAfter.trim();
                const seconds = Number(trimmedRetryAfter);
                if (/^\d+$/.test(trimmedRetryAfter) && Number.isFinite(seconds)) {
                  delayMs = clampTimerTimeoutMs(seconds * 1000, 0) ?? delayMs;
                } else if (RETRY_AFTER_HTTP_DATE_RE.test(trimmedRetryAfter)) {
                  const date = Date.parse(trimmedRetryAfter);
                  if (!Number.isNaN(date)) {
                    delayMs = clampTimerTimeoutMs(date - Date.now(), 0) ?? delayMs;
                  }
                }
              }
            }

            await sleep(delayMs, activeSignal);
            continue;
          }

          // Parse error for friendly message on final attempt or non-retryable error
          const fakeResponse = new Response(errorText, {
            status: response.status,
            statusText: response.statusText,
          });
          const info = await parseErrorResponse(fakeResponse);
          throw new Error(info.friendlyMessage || info.message);
        } catch (error) {
          if (error instanceof Error) {
            if (
              isRequestTimeoutError(error, options?.signal, activeSignal, requestTimeoutMs) &&
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
          lastError = error instanceof Error ? error : new Error(String(error));
          // Network errors are retryable
          if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
            const delayMs = BASE_DELAY_MS * 2 ** attempt;
            await sleep(delayMs, activeSignal);
            continue;
          }
          throw lastError;
        }
      }

      if (!response?.ok) {
        throw lastError ?? new Error("Failed after retries");
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      stream.push({ type: "start", partial: output });
      await processStream(response, output, stream, model, options);

      if (activeSignal?.aborted) {
        throw new Error("Request was aborted");
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      const normalizedError =
        isRequestTimeoutError(error, options?.signal, activeSignal, requestTimeoutMs) &&
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

  return streamOpenAICodexResponses(model, context, {
    ...base,
    reasoningEffort,
  } satisfies OpenAICodexResponsesOptions);
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
  });

  const body: RequestBody = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    input: messages,
    text: { verbosity: options?.textVerbosity || "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key:
      options?.cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options?.serviceTier !== undefined) {
    body.service_tier = options.serviceTier;
  }

  if (context.tools && context.tools.length > 0) {
    body.tools = convertResponsesTools(context.tools, { strict: null });
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

function getServiceTierCostMultiplier(
  model: Pick<Model<"openai-chatgpt-responses">, "id">,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  model: Pick<Model<"openai-chatgpt-responses">, "id">,
) {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
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
): Promise<void> {
  await processResponsesStream(mapCodexEvents(parseSSE(response)), output, stream, model, {
    serviceTier: options?.serviceTier,
    resolveServiceTier: resolveCodexServiceTier,
    applyServiceTierPricing: (usage, serviceTier) =>
      applyServiceTierPricing(usage, serviceTier, model),
  });
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

function isCodexNonTransportError(error: unknown): boolean {
  return error instanceof CodexApiError || error instanceof CodexProtocolError;
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
      const code = (event as { code?: string }).code || "";
      const message = (event as { message?: string }).message || "";
      throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
        code: code || undefined,
        payload: event,
      });
    }

    if (type === "response.failed") {
      const response = (event as { response?: { error?: { code?: string; message?: string } } })
        .response;
      const code = response?.error?.code;
      const message = response?.error?.message;
      throw new CodexApiError(message || "Codex response failed", { code, payload: event });
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
        type: "response.completed",
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
// SSE Parsing
// ============================================================================

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data) as Record<string, unknown>;
            } catch (cause) {
              throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
                cause,
                payload: data,
              });
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

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
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketDebugStats {
  requests: number;
  connectionsCreated: number;
  connectionsReused: number;
  cachedContextRequests: number;
  storeTrueRequests: number;
  fullContextRequests: number;
  deltaRequests: number;
  lastInputItems: number;
  lastDeltaInputItems?: number;
  lastPreviousResponseId?: string;
  websocketFailures: number;
  sseFallbacks: number;
  websocketFallbackActive?: boolean;
  lastWebSocketError?: string;
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
  let stats = websocketDebugStats.get(sessionId);
  if (!stats) {
    stats = {
      requests: 0,
      connectionsCreated: 0,
      connectionsReused: 0,
      cachedContextRequests: 0,
      storeTrueRequests: 0,
      fullContextRequests: 0,
      deltaRequests: 0,
      lastInputItems: 0,
      websocketFailures: 0,
      sseFallbacks: 0,
    };
    websocketDebugStats.set(sessionId, stats);
  }
  return stats;
}

export function getOpenAICodexWebSocketDebugStats(
  sessionId: string,
): OpenAICodexWebSocketDebugStats | undefined {
  const stats = websocketDebugStats.get(sessionId);
  return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
  if (sessionId) {
    websocketDebugStats.delete(sessionId);
    websocketSseFallbackSessions.delete(sessionId);
    return;
  }
  websocketDebugStats.clear();
  websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
  const closeEntry = (entry: CachedWebSocketConnection) => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    closeWebSocketSilently(entry.socket, 1000, "debug_close");
  };
  if (sessionId) {
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
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.sseFallbacks++;
  stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(
  sessionId: string | undefined,
  error: unknown,
  options: { activateSseFallback: boolean },
): void {
  if (!sessionId) {
    return;
  }
  if (options.activateSseFallback) {
    websocketSseFallbackSessions.add(sessionId);
  }

  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.websocketFailures++;
  stats.lastWebSocketError = formatThrownValue(error);
  stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

let cachedWebsocket: WebSocketConstructor | null = null;
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
        let opts: Record<string, unknown> = {};
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

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
  const readyState = (socket as { readyState?: unknown }).readyState;
  return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
  const readyState = getWebSocketReadyState(socket);
  // If readyState is unavailable, assume the runtime keeps it open/reusable.
  return readyState === undefined || readyState === 1;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {}
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
    websocketSessionCache.delete(sessionId);
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
  reused: boolean;
  release: (options?: { keep?: boolean }) => void;
}> {
  if (!sessionId) {
    const socket = await connectWebSocket(url, headers, signal);
    return {
      socket,
      reused: false,
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
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        reused: true,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            websocketSessionCache.delete(sessionId);
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
        reused: false,
        release: () => {
          closeWebSocketSilently(socket);
        },
      };
    }
    if (!isWebSocketReusable(cached.socket)) {
      closeWebSocketSilently(cached.socket);
      websocketSessionCache.delete(sessionId);
    }
  }

  const socket = await connectWebSocket(url, headers, signal);
  const entry: CachedWebSocketConnection = { socket, busy: true };
  websocketSessionCache.set(sessionId, entry);
  return {
    socket,
    entry,
    reused: false,
    release: ({ keep } = {}) => {
      if (!keep || !isWebSocketReusable(entry.socket)) {
        closeWebSocketSilently(entry.socket);
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
        }
        if (websocketSessionCache.get(sessionId) === entry) {
          websocketSessionCache.delete(sessionId);
        }
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

async function decodeWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
    const arrayBuffer = await blobLike.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
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
    void (async () => {
      let text: string | null = null;
      try {
        if (!event || typeof event !== "object" || !("data" in event)) {
          return;
        }
        text = await decodeWebSocketData((event as { data?: unknown }).data);
        if (!text) {
          return;
        }
        const parsed = JSON.parse(text) as Record<string, unknown>;
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
        failed = new CodexProtocolError(
          `Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`,
          {
            cause,
            payload: text,
          },
        );
        done = true;
        wake();
      }
    })();
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
        throw new Error("Request was aborted");
      }
      if (queue.length > 0) {
        yield queue.shift()!;
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
      throw failed;
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
  const { input, previous_response_id: previousResponseId, ...rest } = body;
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
  onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
  let started = false;
  for await (const event of events) {
    if (!started) {
      started = true;
      onStart();
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
  onStart: () => void,
  options?: OpenAICodexResponsesOptions,
): Promise<void> {
  const { socket, entry, reused, release } = await acquireWebSocket(
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
  const stats = options?.sessionId ? getOrCreateWebSocketDebugStats(options.sessionId) : undefined;
  if (stats) {
    stats.requests++;
    if (reused) {
      stats.connectionsReused++;
    } else {
      stats.connectionsCreated++;
    }
    if (useCachedContext) {
      stats.cachedContextRequests++;
    }
    if (requestBody.store === true) {
      stats.storeTrueRequests++;
    }
    stats.lastInputItems = requestBody.input?.length ?? 0;
    if (requestBody.previous_response_id) {
      stats.deltaRequests++;
      stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
      stats.lastPreviousResponseId = requestBody.previous_response_id;
    } else {
      stats.fullContextRequests++;
      stats.lastDeltaInputItems = undefined;
      stats.lastPreviousResponseId = undefined;
    }
  }
  try {
    if (options?.signal?.aborted) {
      throw new Error("Request was aborted");
    }
    socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    await processResponsesStream(
      startWebSocketOutputOnFirstEvent(
        mapCodexEvents(parseWebSocket(socket, options?.signal)),
        output,
        stream,
        onStart,
      ),
      output,
      stream,
      model,
      {
        serviceTier: options?.serviceTier,
        resolveServiceTier: resolveCodexServiceTier,
        applyServiceTierPricing: (usage, serviceTier) =>
          applyServiceTierPricing(usage, serviceTier, model),
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

async function parseErrorResponse(
  response: Response,
): Promise<{ message: string; friendlyMessage?: string }> {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
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
        response.status === 429
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
