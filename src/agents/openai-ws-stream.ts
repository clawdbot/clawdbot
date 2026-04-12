import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  StopReason,
} from "@mariozechner/pi-ai";
import * as piAi from "@mariozechner/pi-ai";
/**
 * OpenAI WebSocket StreamFn Integration
 *
 * Wraps `OpenAIWebSocketManager` in a `StreamFn` that can be plugged into the
 * pi-embedded-runner agent in place of the default `streamSimple` HTTP function.
 *
 * Key behaviours:
 *  - Per-session `OpenAIWebSocketManager` (keyed by sessionId)
 *  - Tracks `previous_response_id` to send only incremental tool-result inputs
 *  - Falls back to `streamSimple` (HTTP) if the WebSocket connection fails
 *  - Cleanup helpers for releasing sessions after the run completes
 *
 * Complexity budget & risk mitigation:
 *  - **Transport aware**: respects `transport` (`auto` | `websocket` | `sse`)
 *  - **Transparent fallback in `auto` mode**: connect/send failures fall back to
 *    the existing HTTP `streamSimple`; forced `websocket` mode surfaces WS errors
 *  - **Zero shared state**: per-session registry; session cleanup on dispose prevents leaks
 *  - **Full parity**: all generation options (temperature, top_p, max_output_tokens,
 *    tool_choice, reasoning) forwarded identically to the HTTP path
 *
 * @see src/agents/openai-ws-connection.ts for the connection manager
 */
import { formatErrorMessage } from "../infra/errors.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import {
  resolveProviderTransportTurnStateWithPlugin,
  resolveProviderWebSocketSessionPolicyWithPlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderTransportTurnState } from "../plugins/types.js";
import {
  encodeAssistantTextSignature,
  normalizeAssistantPhase,
} from "../shared/chat-message-content.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveOpenAIStrictToolSetting } from "./openai-tool-schema.js";
import {
  getOpenAIWebSocketErrorDetails,
  OpenAIWebSocketManager,
  type FunctionToolDefinition,
  type OpenAIResponsesAssistantPhase,
  type OpenAIWebSocketManagerOptions,
} from "./openai-ws-connection.js";
import {
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
  planTurnInput,
} from "./openai-ws-message-conversion.js";
import { buildOpenAIWebSocketResponseCreatePayload } from "./openai-ws-request.js";
import { log } from "./pi-embedded-runner/logger.js";
import { normalizeProviderId } from "./provider-id.js";
import { createBoundaryAwareStreamFnForModel } from "./provider-transport-stream.js";
import {
  buildAssistantMessageWithZeroUsage,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
import { mergeTransportMetadata } from "./transport-stream-shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-session state
// ─────────────────────────────────────────────────────────────────────────────

interface WsSession {
  manager: OpenAIWebSocketManager;
  managerConfigSignature: string;
  /** Number of messages that were in context.messages at the END of the last streamFn call. */
  lastContextLength: number;
  /** True if the connection has been established at least once. */
  everConnected: boolean;
  /** True once a best-effort warm-up attempt has run for this session. */
  warmUpAttempted: boolean;
  /** True if the session is permanently broken (no more reconnect). */
  broken: boolean;
  /** Session-scoped cool-down after repeated websocket failures. */
  degradedUntil: number | null;
  degradeCooldownMs: number;
}

function resolveOpenAIWebSocketStrictToolSetting(
  model: Parameters<StreamFn>[0],
): boolean | undefined {
  return resolveOpenAIStrictToolSetting(model, {
    transport: "websocket",
    supportsStrictMode:
      model.compat && typeof model.compat === "object"
        ? (model.compat as { supportsStrictMode?: boolean }).supportsStrictMode
        : undefined,
  });
}

/** Module-level registry: sessionId → WsSession */
const wsRegistry = new Map<string, WsSession>();

type OpenAIWsStreamDeps = {
  createManager: (options?: OpenAIWebSocketManagerOptions) => OpenAIWebSocketManager;
  createHttpFallbackStreamFn: (model: ProviderRuntimeModel) => StreamFn | undefined;
  streamSimple: typeof piAi.streamSimple;
};

type AssistantMessageWithPhase = AssistantMessage & { phase?: OpenAIResponsesAssistantPhase };

const defaultOpenAIWsStreamDeps: OpenAIWsStreamDeps = {
  createManager: (options) => new OpenAIWebSocketManager(options),
  createHttpFallbackStreamFn: (model) => createBoundaryAwareStreamFnForModel(model),
  streamSimple: (...args) => piAi.streamSimple(...args),
};

let openAIWsStreamDeps: OpenAIWsStreamDeps = defaultOpenAIWsStreamDeps;

type AssistantMessageEventStreamLike = {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
};

class LocalAssistantMessageEventStream implements AssistantMessageEventStreamLike {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiting: Array<(value: IteratorResult<AssistantMessageEvent>) => void> = [];
  private done = false;
  private readonly finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (result: AssistantMessage) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) {
      return;
    }
    if (event.type === "done") {
      this.done = true;
      this.resolveFinalResult(event.message);
    } else if (event.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined as unknown as AssistantMessageEvent, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) {
        return;
      }
      const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }
}

function createEventStream(): AssistantMessageEventStream {
  return typeof piAi.createAssistantMessageEventStream === "function"
    ? piAi.createAssistantMessageEventStream()
    : (new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public registry helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Release and close the WebSocket session for the given sessionId.
 * Call this after the agent run completes to free the connection.
 */
export function releaseWsSession(sessionId: string): void {
  const session = wsRegistry.get(sessionId);
  if (session) {
    try {
      session.manager.close();
    } catch {
      // Ignore close errors — connection may already be gone.
    }
    wsRegistry.delete(sessionId);
  }
}

/**
 * Returns true if a live WebSocket session exists for the given sessionId.
 */
export function hasWsSession(sessionId: string): boolean {
  const s = wsRegistry.get(sessionId);
  return !!(s && !s.broken && s.manager.isConnected());
}

export {
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
  planTurnInput,
} from "./openai-ws-message-conversion.js";

// ─────────────────────────────────────────────────────────────────────────────
// StreamFn factory
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIWebSocketStreamOptions {
  /** Manager options (url override, retry counts, etc.) */
  managerOptions?: OpenAIWebSocketManagerOptions;
  /** Abort signal forwarded from the run. */
  signal?: AbortSignal;
}

type WsTransport = "sse" | "websocket" | "auto";
const WARM_UP_TIMEOUT_MS = 8_000;
const MAX_AUTO_WS_RUNTIME_RETRIES = 1;
const DEFAULT_WS_DEGRADE_COOLDOWN_MS = 60_000;
let wsDegradeCooldownMsOverride: number | undefined;

class OpenAIWebSocketRuntimeError extends Error {
  readonly kind: "disconnect" | "send" | "server";
  readonly retryable: boolean;
  readonly closeCode?: number;
  readonly closeReason?: string;

  constructor(
    message: string,
    params: {
      kind: "disconnect" | "send" | "server";
      retryable: boolean;
      closeCode?: number;
      closeReason?: string;
    },
  ) {
    super(message);
    this.name = "OpenAIWebSocketRuntimeError";
    this.kind = params.kind;
    this.retryable = params.retryable;
    this.closeCode = params.closeCode;
    this.closeReason = params.closeReason;
  }
}

function resolveWsTransport(options: Parameters<StreamFn>[2]): WsTransport {
  const transport = (options as { transport?: unknown } | undefined)?.transport;
  return transport === "sse" || transport === "websocket" || transport === "auto"
    ? transport
    : "auto";
}

type WsOptions = Parameters<StreamFn>[2] & { openaiWsWarmup?: unknown; signal?: AbortSignal };

function resolveWsWarmup(options: Parameters<StreamFn>[2]): boolean {
  const warmup = (options as WsOptions | undefined)?.openaiWsWarmup;
  return warmup === true;
}

function resetWsSession(params: {
  session: WsSession;
  createManager: () => OpenAIWebSocketManager;
  preserveDegradeUntil?: boolean;
}): void {
  try {
    params.session.manager.close();
  } catch {
    /* ignore */
  }
  params.session.manager = params.createManager();
  params.session.everConnected = false;
  params.session.warmUpAttempted = false;
  params.session.broken = false;
  if (!params.preserveDegradeUntil) {
    params.session.degradedUntil = null;
  }
}

function markWsSessionDegraded(session: WsSession): void {
  session.degradedUntil = Date.now() + session.degradeCooldownMs;
}

function isWsSessionDegraded(session: WsSession): boolean {
  if (!session.degradedUntil) {
    return false;
  }
  if (session.degradedUntil <= Date.now()) {
    session.degradedUntil = null;
    return false;
  }
  return true;
}

function createWsManager(
  managerOptions: OpenAIWebSocketManagerOptions | undefined,
  sessionHeaders?: Record<string, string>,
): OpenAIWebSocketManager {
  return openAIWsStreamDeps.createManager({
    ...managerOptions,
    ...(sessionHeaders
      ? {
          headers: {
            ...managerOptions?.headers,
            ...sessionHeaders,
          },
        }
      : {}),
  });
}

function stringifyStable(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyStable(entry)).join(",")}]`;
  }
  const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyStable(entry)}`)
    .join(",")}}`;
}

function resolveWsManagerConfigSignature(
  managerOptions: OpenAIWebSocketManagerOptions | undefined,
  sessionHeaders?: Record<string, string>,
): string {
  return stringifyStable({
    headers: sessionHeaders,
    request: managerOptions?.request,
    url: managerOptions?.url,
  });
}

const AZURE_OPENAI_PROVIDER_IDS = new Set(["azure-openai", "azure-openai-responses"]);
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return (
      url.protocol === "https:" &&
      normalizeLowercaseStringOrEmpty(url.hostname) === "api.openai.com" &&
      /^\/v1\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/chatgpt\.com\/backend-api\/?$/iu.test(trimmed);
}

function isAzureOpenAIBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return normalizeLowercaseStringOrEmpty(new URL(trimmed).hostname).endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function normalizeTransportIdentityValue(value: string, maxLength = 160): string {
  const trimmed = value.trim().replace(/[\r\n]+/gu, " ");
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function usesNativeOpenAIRoute(provider: string, baseUrl?: string): boolean {
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedProvider) {
    return false;
  }
  if (normalizedProvider === "openai") {
    return !baseUrl || isOpenAIApiBaseUrl(baseUrl);
  }
  if (AZURE_OPENAI_PROVIDER_IDS.has(normalizedProvider)) {
    return !baseUrl || isAzureOpenAIBaseUrl(baseUrl);
  }
  if (normalizedProvider === OPENAI_CODEX_PROVIDER_ID) {
    return !baseUrl || isOpenAIApiBaseUrl(baseUrl) || isOpenAICodexBaseUrl(baseUrl);
  }
  return false;
}

function resolveNativeOpenAISessionHeaders(params: {
  provider: string;
  baseUrl?: string;
  sessionId?: string;
}): Record<string, string> | undefined {
  if (!params.sessionId || !usesNativeOpenAIRoute(params.provider, params.baseUrl)) {
    return undefined;
  }
  const sessionId = normalizeTransportIdentityValue(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  return {
    "x-client-request-id": sessionId,
    "x-openclaw-session-id": sessionId,
  };
}

function resolveNativeOpenAITransportTurnState(params: {
  provider: string;
  baseUrl?: string;
  sessionId?: string;
  turnId: string;
  attempt: number;
  transport: "stream" | "websocket";
}): ProviderTransportTurnState | undefined {
  const sessionHeaders = resolveNativeOpenAISessionHeaders({
    provider: params.provider,
    baseUrl: params.baseUrl,
    sessionId: params.sessionId,
  });
  if (!sessionHeaders) {
    return undefined;
  }
  const turnId = normalizeTransportIdentityValue(params.turnId);
  const attempt = String(Math.max(1, params.attempt));
  return {
    headers: {
      ...sessionHeaders,
      "x-openclaw-turn-id": turnId,
      "x-openclaw-turn-attempt": attempt,
    },
    metadata: {
      openclaw_session_id: sessionHeaders["x-openclaw-session-id"] ?? "",
      openclaw_turn_id: turnId,
      openclaw_turn_attempt: attempt,
      openclaw_transport: params.transport,
    },
  };
}

function resolveProviderTransportTurnState(
  model: Parameters<StreamFn>[0],
  params: {
    sessionId?: string;
    turnId: string;
    attempt: number;
    transport: "stream" | "websocket";
  },
): ProviderTransportTurnState | undefined {
  if (usesNativeOpenAIRoute(model.provider, (model as { baseUrl?: string }).baseUrl)) {
    return resolveNativeOpenAITransportTurnState({
      provider: model.provider,
      baseUrl: (model as { baseUrl?: string }).baseUrl,
      sessionId: params.sessionId,
      turnId: params.turnId,
      attempt: params.attempt,
      transport: params.transport,
    });
  }
  return (
    resolveProviderTransportTurnStateWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: model as ProviderRuntimeModel,
        sessionId: params.sessionId,
        turnId: params.turnId,
        attempt: params.attempt,
        transport: params.transport,
      },
    }) ?? undefined
  );
}

function resolveWebSocketSessionPolicy(
  model: Parameters<StreamFn>[0],
  sessionId: string,
): { headers?: Record<string, string>; degradeCooldownMs: number } {
  if (usesNativeOpenAIRoute(model.provider, (model as { baseUrl?: string }).baseUrl)) {
    return {
      headers: resolveNativeOpenAISessionHeaders({
        provider: model.provider,
        baseUrl: (model as { baseUrl?: string }).baseUrl,
        sessionId,
      }),
      degradeCooldownMs: Math.max(0, wsDegradeCooldownMsOverride ?? DEFAULT_WS_DEGRADE_COOLDOWN_MS),
    };
  }
  const policy = resolveProviderWebSocketSessionPolicyWithPlugin({
    provider: model.provider,
    context: {
      provider: model.provider,
      modelId: model.id,
      model: model as ProviderRuntimeModel,
      sessionId,
    },
  });
  return {
    headers: policy?.headers,
    degradeCooldownMs: Math.max(
      0,
      wsDegradeCooldownMsOverride ?? policy?.degradeCooldownMs ?? DEFAULT_WS_DEGRADE_COOLDOWN_MS,
    ),
  };
}

function formatOpenAIWebSocketError(
  event: Parameters<OpenAIWebSocketManager["onMessage"]>[0] extends (arg: infer T) => void
    ? Extract<T, { type: "error" }>
    : never,
): string {
  const details = getOpenAIWebSocketErrorDetails(event);
  const code = details.code ?? "unknown";
  const message = details.message ?? "Unknown error";
  const extras = [
    typeof details.status === "number" ? `status=${details.status}` : null,
    details.type ? `type=${details.type}` : null,
    details.param ? `param=${details.param}` : null,
  ].filter(Boolean);
  return extras.length > 0
    ? `${message} (code=${code}; ${extras.join(", ")})`
    : `${message} (code=${code})`;
}

function formatOpenAIWebSocketResponseFailure(response: {
  error?: { code?: string; message?: string };
  incomplete_details?: { reason?: string };
}): string {
  if (response.error) {
    return `${response.error.code || "unknown"}: ${response.error.message || "no message"}`;
  }
  if (response.incomplete_details?.reason) {
    return `incomplete: ${response.incomplete_details.reason}`;
  }
  return "Unknown error (no error details in response)";
}

function normalizeWsRunError(err: unknown): OpenAIWebSocketRuntimeError {
  if (err instanceof OpenAIWebSocketRuntimeError) {
    return err;
  }
  return new OpenAIWebSocketRuntimeError(formatErrorMessage(err), {
    kind: "server",
    retryable: false,
  });
}

function buildRetryableSendError(err: unknown): OpenAIWebSocketRuntimeError {
  return new OpenAIWebSocketRuntimeError(
    err instanceof Error ? err.message : `WebSocket send failed: ${String(err)}`,
    {
      kind: "send",
      retryable: true,
    },
  );
}
async function runWarmUp(params: {
  manager: OpenAIWebSocketManager;
  modelId: string;
  tools: FunctionToolDefinition[];
  instructions?: string;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    throw new Error("aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`warm-up timed out after ${WARM_UP_TIMEOUT_MS}ms`));
    }, WARM_UP_TIMEOUT_MS);

    const abortHandler = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const closeHandler = (code: number, reason: string) => {
      cleanup();
      reject(new Error(`warm-up closed (code=${code}, reason=${reason || "unknown"})`));
    };
    const unsubscribe = params.manager.onMessage((event) => {
      if (event.type === "response.completed") {
        cleanup();
        resolve();
      } else if (event.type === "response.failed") {
        cleanup();
        reject(
          new Error(`warm-up failed: ${formatOpenAIWebSocketResponseFailure(event.response)}`),
        );
      } else if (event.type === "error") {
        cleanup();
        reject(new Error(`warm-up error: ${formatOpenAIWebSocketError(event)}`));
      }
    });

    const cleanup = () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abortHandler);
      params.manager.off("close", closeHandler);
      unsubscribe();
    };

    params.signal?.addEventListener("abort", abortHandler, { once: true });
    params.manager.on("close", closeHandler);
    params.manager.warmUp({
      model: params.modelId,
      tools: params.tools.length > 0 ? params.tools : undefined,
      instructions: params.instructions,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    });
  });
}

/**
 * Creates a `StreamFn` backed by a persistent WebSocket connection to the
 * OpenAI Responses API.  The first call for a given `sessionId` opens the
 * connection; subsequent calls reuse it, sending only incremental tool-result
 * inputs with `previous_response_id`.
 *
 * If the WebSocket connection is unavailable, the function falls back to the
 * standard `streamSimple` HTTP path and logs a warning.
 *
 * @param apiKey     OpenAI API key
 * @param sessionId  Agent session ID (used as the registry key)
 * @param opts       Optional manager + abort signal overrides
 */
export function createOpenAIWebSocketStreamFn(
  apiKey: string,
  sessionId: string,
  opts: OpenAIWebSocketStreamOptions = {},
): StreamFn {
  return (model, context, options) => {
    const eventStream = createEventStream();

    const run = async () => {
      const transport = resolveWsTransport(options);
      if (transport === "sse") {
        return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal);
      }

      const signal = opts.signal ?? (options as WsOptions | undefined)?.signal;
      let emittedStart = false;
      let runtimeRetries = 0;
      const turnId = randomUUID();
      let turnAttempt = 0;
      const wsSessionPolicy = resolveWebSocketSessionPolicy(model, sessionId);
      const sessionHeaders = wsSessionPolicy.headers;

      while (true) {
        let session = wsRegistry.get(sessionId);
        const managerConfigSignature = resolveWsManagerConfigSignature(
          opts.managerOptions,
          sessionHeaders,
        );
        if (!session) {
          const manager = createWsManager(opts.managerOptions, sessionHeaders);
          session = {
            manager,
            managerConfigSignature,
            lastContextLength: 0,
            everConnected: false,
            warmUpAttempted: false,
            broken: false,
            degradedUntil: null,
            degradeCooldownMs: wsSessionPolicy.degradeCooldownMs,
          };
          wsRegistry.set(sessionId, session);
        } else if (session.managerConfigSignature !== managerConfigSignature) {
          resetWsSession({
            session,
            createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
          });
          session.managerConfigSignature = managerConfigSignature;
          session.degradeCooldownMs = wsSessionPolicy.degradeCooldownMs;
        }

        if (transport !== "websocket" && isWsSessionDegraded(session)) {
          log.debug(
            `[ws-stream] session=${sessionId} in websocket cool-down; using HTTP fallback until ${new Date(session.degradedUntil!).toISOString()}`,
          );
          return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
            suppressStart: emittedStart,
            turnState: resolveProviderTransportTurnState(model, {
              sessionId,
              turnId,
              attempt: Math.max(1, turnAttempt),
              transport: "stream",
            }),
          });
        }

        if (!session.manager.isConnected() && !session.broken) {
          try {
            await session.manager.connect(apiKey);
            session.everConnected = true;
            session.degradedUntil = null;
            log.debug(`[ws-stream] connected for session=${sessionId}`);
          } catch (connErr) {
            markWsSessionDegraded(session);
            resetWsSession({
              session,
              createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
              preserveDegradeUntil: true,
            });
            if (transport === "websocket") {
              throw connErr instanceof Error ? connErr : new Error(String(connErr));
            }
            log.warn(
              `[ws-stream] WebSocket connect failed for session=${sessionId}; falling back to HTTP. error=${String(connErr)}`,
            );
            return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
              suppressStart: emittedStart,
              turnState: resolveProviderTransportTurnState(model, {
                sessionId,
                turnId,
                attempt: Math.max(1, turnAttempt),
                transport: "stream",
              }),
            });
          }
        }

        if (session.broken || !session.manager.isConnected()) {
          if (transport === "websocket") {
            throw new Error("WebSocket session disconnected");
          }
          log.warn(`[ws-stream] session=${sessionId} broken/disconnected; falling back to HTTP`);
          markWsSessionDegraded(session);
          resetWsSession({
            session,
            createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
            preserveDegradeUntil: true,
          });
          return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
            suppressStart: emittedStart,
            turnState: resolveProviderTransportTurnState(model, {
              sessionId,
              turnId,
              attempt: Math.max(1, turnAttempt),
              transport: "stream",
            }),
          });
        }

        if (resolveWsWarmup(options) && !session.warmUpAttempted) {
          session.warmUpAttempted = true;
          let warmupFailed = false;
          try {
            await runWarmUp({
              manager: session.manager,
              modelId: model.id,
              tools: convertTools(context.tools, {
                strict: resolveOpenAIWebSocketStrictToolSetting(model),
              }),
              instructions: context.systemPrompt
                ? stripSystemPromptCacheBoundary(context.systemPrompt)
                : undefined,
              metadata: resolveProviderTransportTurnState(model, {
                sessionId,
                turnId,
                attempt: Math.max(1, turnAttempt),
                transport: "websocket",
              })?.metadata,
              signal,
            });
            log.debug(`[ws-stream] warm-up completed for session=${sessionId}`);
          } catch (warmErr) {
            if (signal?.aborted) {
              throw warmErr instanceof Error ? warmErr : new Error(String(warmErr));
            }
            warmupFailed = true;
            log.warn(
              `[ws-stream] warm-up failed for session=${sessionId}; continuing without warm-up. error=${String(warmErr)}`,
            );
          }
          if (warmupFailed && !session.manager.isConnected()) {
            try {
              session.manager.close();
            } catch {
              /* ignore */
            }
            try {
              session.manager = createWsManager(opts.managerOptions, sessionHeaders);
              await session.manager.connect(apiKey);
              session.everConnected = true;
              session.degradedUntil = null;
              log.debug(`[ws-stream] reconnected after warm-up failure for session=${sessionId}`);
            } catch (reconnectErr) {
              markWsSessionDegraded(session);
              resetWsSession({
                session,
                createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
                preserveDegradeUntil: true,
              });
              if (transport === "websocket") {
                throw reconnectErr instanceof Error
                  ? reconnectErr
                  : new Error(String(reconnectErr));
              }
              log.warn(
                `[ws-stream] reconnect after warm-up failed for session=${sessionId}; falling back to HTTP. error=${String(reconnectErr)}`,
              );
              return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
                suppressStart: emittedStart,
                turnState: resolveProviderTransportTurnState(model, {
                  sessionId,
                  turnId,
                  attempt: Math.max(1, turnAttempt),
                  transport: "stream",
                }),
              });
            }
          }
        }

        const turnInput = planTurnInput({
          context,
          model,
          previousResponseId: session.manager.previousResponseId,
          lastContextLength: session.lastContextLength,
        });

        if (turnInput.mode === "incremental_tool_results") {
          log.debug(
            `[ws-stream] session=${sessionId}: incremental send (${turnInput.inputItems.length} tool results) previous_response_id=${turnInput.previousResponseId}`,
          );
        } else if (turnInput.mode === "full_context_restart") {
          log.debug(
            `[ws-stream] session=${sessionId}: no new tool results found; sending full context without previous_response_id`,
          );
        } else {
          log.debug(
            `[ws-stream] session=${sessionId}: full context send (${turnInput.inputItems.length} items)`,
          );
        }

        turnAttempt++;
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId,
          turnId,
          attempt: turnAttempt,
          transport: "websocket",
        });
        let payload = buildOpenAIWebSocketResponseCreatePayload({
          model,
          context,
          options: options as WsOptions | undefined,
          turnInput,
          tools: convertTools(context.tools, {
            strict: resolveOpenAIWebSocketStrictToolSetting(model),
          }),
          metadata: turnState?.metadata,
        }) as Record<string, unknown>;
        const nextPayload = await options?.onPayload?.(payload, model);
        payload = mergeTransportMetadata(
          (nextPayload ?? payload) as Record<string, unknown>,
          turnState?.metadata,
        );
        const requestPayload = payload as Parameters<OpenAIWebSocketManager["send"]>[0];

        try {
          session.manager.send(requestPayload);
        } catch (sendErr) {
          const normalizedErr = buildRetryableSendError(sendErr);
          if (
            transport !== "websocket" &&
            !signal?.aborted &&
            runtimeRetries < MAX_AUTO_WS_RUNTIME_RETRIES
          ) {
            runtimeRetries++;
            log.warn(
              `[ws-stream] retrying websocket turn after send failure for session=${sessionId} (${runtimeRetries}/${MAX_AUTO_WS_RUNTIME_RETRIES}). error=${normalizedErr.message}`,
            );
            resetWsSession({
              session,
              createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
            });
            continue;
          }
          if (transport !== "websocket") {
            log.warn(
              `[ws-stream] send failed for session=${sessionId}; falling back to HTTP. error=${normalizedErr.message}`,
            );
            markWsSessionDegraded(session);
            resetWsSession({
              session,
              createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
              preserveDegradeUntil: true,
            });
            return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
              suppressStart: emittedStart,
              turnState: resolveProviderTransportTurnState(model, {
                sessionId,
                turnId,
                attempt: turnAttempt,
                transport: "stream",
              }),
            });
          }
          throw normalizedErr;
        }

        if (!emittedStart) {
          eventStream.push({
            type: "start",
            partial: buildAssistantMessageWithZeroUsage({
              model,
              content: [],
              stopReason: "stop",
            }),
          });
          emittedStart = true;
        }

        const outputItemPhaseById = new Map<string, OpenAIResponsesAssistantPhase | undefined>();
        const outputTextByPart = new Map<string, string>();
        const emittedTextByPart = new Map<string, string>();
        const getOutputTextKey = (itemId: string, contentIndex: number) =>
          `${itemId}:${contentIndex}`;
        const emitTextDelta = (params: {
          fullText: string;
          deltaText: string;
          itemId?: string;
          contentIndex?: number;
        }) => {
          const resolvedItemId = params.itemId;
          const contentIndex = params.contentIndex ?? 0;
          const itemPhase = resolvedItemId
            ? normalizeAssistantPhase(outputItemPhaseById.get(resolvedItemId))
            : undefined;
          const partialBase = buildAssistantMessageWithZeroUsage({
            model,
            content: [
              {
                type: "text",
                text: params.fullText,
                ...(resolvedItemId
                  ? {
                      textSignature: encodeAssistantTextSignature({
                        id: resolvedItemId,
                        ...(itemPhase ? { phase: itemPhase } : {}),
                      }),
                    }
                  : {}),
              },
            ],
            stopReason: "stop",
          });
          const partialMsg: AssistantMessageWithPhase = itemPhase
            ? ({ ...partialBase, phase: itemPhase } as AssistantMessageWithPhase)
            : partialBase;
          eventStream.push({
            type: "text_delta",
            contentIndex,
            delta: params.deltaText,
            partial: partialMsg,
          });
        };
        const emitBufferedTextDelta = (params: { itemId: string; contentIndex: number }) => {
          const key = getOutputTextKey(params.itemId, params.contentIndex);
          const fullText = outputTextByPart.get(key) ?? "";
          const emittedText = emittedTextByPart.get(key) ?? "";
          if (!fullText || fullText === emittedText) {
            return;
          }
          const deltaText = fullText.startsWith(emittedText)
            ? fullText.slice(emittedText.length)
            : fullText;
          emittedTextByPart.set(key, fullText);
          emitTextDelta({
            fullText,
            deltaText,
            itemId: params.itemId,
            contentIndex: params.contentIndex,
          });
        };
        const capturedContextLength = context.messages.length;
        let sawWsOutput = false;

        try {
          await new Promise<void>((resolve, reject) => {
            const abortHandler = () => {
              outputItemPhaseById.clear();
              outputTextByPart.clear();
              emittedTextByPart.clear();
              cleanup();
              reject(new Error("aborted"));
            };
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal?.addEventListener("abort", abortHandler, { once: true });

            const closeHandler = (code: number, reason: string) => {
              outputItemPhaseById.clear();
              outputTextByPart.clear();
              emittedTextByPart.clear();
              cleanup();
              const closeInfo = session.manager.lastCloseInfo;
              reject(
                new OpenAIWebSocketRuntimeError(
                  `WebSocket closed mid-request (code=${code}, reason=${reason || "unknown"})`,
                  {
                    kind: "disconnect",
                    retryable: closeInfo?.retryable ?? true,
                    closeCode: closeInfo?.code ?? code,
                    closeReason: closeInfo?.reason ?? reason,
                  },
                ),
              );
            };
            session.manager.on("close", closeHandler);

            const cleanup = () => {
              signal?.removeEventListener("abort", abortHandler);
              session.manager.off("close", closeHandler);
              unsubscribe();
            };

            const unsubscribe = session.manager.onMessage((event) => {
              if (
                event.type === "response.output_item.added" ||
                event.type === "response.output_item.done" ||
                event.type === "response.content_part.added" ||
                event.type === "response.content_part.done" ||
                event.type === "response.output_text.delta" ||
                event.type === "response.output_text.done" ||
                event.type === "response.function_call_arguments.delta" ||
                event.type === "response.function_call_arguments.done"
              ) {
                sawWsOutput = true;
              }

              if (
                event.type === "response.output_item.added" ||
                event.type === "response.output_item.done"
              ) {
                if (typeof event.item.id === "string") {
                  const itemPhase =
                    event.item.type === "message"
                      ? normalizeAssistantPhase((event.item as { phase?: unknown }).phase)
                      : undefined;
                  outputItemPhaseById.set(event.item.id, itemPhase);
                  if (itemPhase !== undefined) {
                    for (const key of outputTextByPart.keys()) {
                      if (key.startsWith(`${event.item.id}:`)) {
                        const [, contentIndexText] = key.split(":");
                        emitBufferedTextDelta({
                          itemId: event.item.id,
                          contentIndex: Number.parseInt(contentIndexText ?? "0", 10) || 0,
                        });
                      }
                    }
                  }
                }
                return;
              }

              if (event.type === "response.output_text.delta") {
                const key = getOutputTextKey(event.item_id, event.content_index);
                const nextText = `${outputTextByPart.get(key) ?? ""}${event.delta}`;
                outputTextByPart.set(key, nextText);
                if (outputItemPhaseById.get(event.item_id) !== undefined) {
                  emitBufferedTextDelta({
                    itemId: event.item_id,
                    contentIndex: event.content_index,
                  });
                }
                return;
              }

              if (event.type === "response.output_text.done") {
                const key = getOutputTextKey(event.item_id, event.content_index);
                if (event.text && event.text !== outputTextByPart.get(key)) {
                  outputTextByPart.set(key, event.text);
                }
                if (outputItemPhaseById.get(event.item_id) !== undefined) {
                  emitBufferedTextDelta({
                    itemId: event.item_id,
                    contentIndex: event.content_index,
                  });
                }
                return;
              }

              if (event.type === "response.completed") {
                outputItemPhaseById.clear();
                outputTextByPart.clear();
                emittedTextByPart.clear();
                cleanup();
                session.lastContextLength = capturedContextLength;
                const assistantMsg = buildAssistantMessageFromResponse(event.response, {
                  api: model.api,
                  provider: model.provider,
                  id: model.id,
                });
                const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
                  assistantMsg.stopReason === "toolUse" ? "toolUse" : "stop";
                eventStream.push({ type: "done", reason, message: assistantMsg });
                resolve();
              } else if (event.type === "response.failed") {
                outputItemPhaseById.clear();
                outputTextByPart.clear();
                emittedTextByPart.clear();
                cleanup();
                reject(
                  new OpenAIWebSocketRuntimeError(
                    `OpenAI WebSocket response failed: ${formatOpenAIWebSocketResponseFailure(event.response)}`,
                    {
                      kind: "server",
                      retryable: false,
                    },
                  ),
                );
              } else if (event.type === "error") {
                outputItemPhaseById.clear();
                outputTextByPart.clear();
                emittedTextByPart.clear();
                cleanup();
                reject(
                  new OpenAIWebSocketRuntimeError(
                    `OpenAI WebSocket error: ${formatOpenAIWebSocketError(event)}`,
                    {
                      kind: "server",
                      retryable: false,
                    },
                  ),
                );
              }
            });
          });
          return;
        } catch (wsRunErr) {
          const normalizedErr = normalizeWsRunError(wsRunErr);
          if (
            transport !== "websocket" &&
            !signal?.aborted &&
            normalizedErr.retryable &&
            !sawWsOutput &&
            runtimeRetries < MAX_AUTO_WS_RUNTIME_RETRIES
          ) {
            runtimeRetries++;
            log.warn(
              `[ws-stream] retrying websocket turn after retryable runtime failure for session=${sessionId} (${runtimeRetries}/${MAX_AUTO_WS_RUNTIME_RETRIES}). error=${normalizedErr.message}`,
            );
            resetWsSession({
              session,
              createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
            });
            continue;
          }
          if (transport !== "websocket" && !signal?.aborted && !sawWsOutput) {
            log.warn(
              `[ws-stream] session=${sessionId} runtime failure before output; falling back to HTTP. error=${normalizedErr.message}`,
            );
            markWsSessionDegraded(session);
            resetWsSession({
              session,
              createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
              preserveDegradeUntil: true,
            });
            return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
              suppressStart: true,
              turnState: resolveProviderTransportTurnState(model, {
                sessionId,
                turnId,
                attempt: turnAttempt,
                transport: "stream",
              }),
            });
          }
          throw normalizedErr;
        }
      }
    };

    queueMicrotask(() =>
      run().catch((err) => {
        const errorMessage = formatErrorMessage(err);
        log.warn(`[ws-stream] session=${sessionId} run error: ${errorMessage}`);
        eventStream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage,
          }),
        });
        eventStream.end();
      }),
    );

    return eventStream;
  };
}

/**
 * Fall back to HTTP and pipe events into the existing stream.
 * This is called when the WebSocket is broken or unavailable.
 */
async function fallbackToHttp(
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  streamOptions: Parameters<StreamFn>[2],
  apiKey: string,
  eventStream: AssistantMessageEventStreamLike,
  signal?: AbortSignal,
  fallbackOptions?: {
    suppressStart?: boolean;
    turnState?: ProviderTransportTurnState;
  },
): Promise<void> {
  const baseOnPayload = streamOptions?.onPayload;
  const mergedOptions = {
    ...streamOptions,
    apiKey,
    ...(fallbackOptions?.turnState?.headers
      ? {
          headers: {
            ...streamOptions?.headers,
            ...fallbackOptions.turnState.headers,
          },
        }
      : {}),
    ...(fallbackOptions?.turnState?.metadata
      ? {
          onPayload: async (
            payload: unknown,
            payloadModel: Parameters<NonNullable<typeof baseOnPayload>>[1],
          ) => {
            const nextPayload = await baseOnPayload?.(payload, payloadModel);
            const resolvedPayload = (nextPayload ?? payload) as Record<string, unknown>;
            return mergeTransportMetadata(resolvedPayload, fallbackOptions.turnState?.metadata);
          },
        }
      : {}),
    ...(signal ? { signal } : {}),
  };
  const httpStreamFn =
    openAIWsStreamDeps.createHttpFallbackStreamFn(model as ProviderRuntimeModel) ??
    openAIWsStreamDeps.streamSimple;
  const httpStream = await httpStreamFn(model, context, mergedOptions);
  for await (const event of httpStream) {
    if (fallbackOptions?.suppressStart && event.type === "start") {
      continue;
    }
    eventStream.push(event);
  }
}

export const __testing = {
  setDepsForTest(overrides?: Partial<OpenAIWsStreamDeps>) {
    openAIWsStreamDeps = overrides
      ? {
          ...defaultOpenAIWsStreamDeps,
          ...overrides,
        }
      : defaultOpenAIWsStreamDeps;
  },
  setWsDegradeCooldownMsForTest(nextMs?: number) {
    wsDegradeCooldownMsOverride = nextMs;
  },
};
