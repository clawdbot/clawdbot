import type OpenAI from "openai";
import type {
  ResponseInput,
  ResponsesClientEvent,
  ResponsesServerEvent,
} from "openai/resources/responses/responses.js";
import { ResponsesWS } from "openai/resources/responses/ws.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import {
  OpenAIResponsesWebSocketPostDispatchError,
  OpenAIResponsesWebSocketPreDispatchError,
  OpenAIResponsesWebSocketResponseFailedError,
} from "./openai-responses-contracts.js";
import { transportAbortError } from "./transport-stream-shared.js";
import { sha256Hex } from "./transport-utils.js";

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const WEBSOCKET_OPEN_STATE = 1;

type ResponsesWebSocketRequest = Record<string, unknown> & {
  input?: ResponseInput;
  previous_response_id?: string;
};

type CachedWebSocketContinuation = {
  lastRequest: ResponsesWebSocketRequest;
  lastResponseId: string;
  lastResponseItems: ResponseInput;
};

type CachedWebSocketConnection = {
  socket: ResponsesWS;
  sessionId: string;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuation;
};

type ResponsesWebSocketStreamMessage =
  ReturnType<ResponsesWS["stream"]> extends AsyncIterable<infer T> ? T : never;

export type OpenAIResponsesWebSocketMode = "websocket" | "websocket-cached" | "auto";

type OpenAIResponsesWebSocketStream = {
  stream: AsyncIterable<unknown>;
  request: ResponsesWebSocketRequest;
  reusedConnection: boolean;
  continuationStatus:
    | "continued"
    | "explicit_previous_response_id"
    | "history_changed"
    | "history_shorter"
    | "no_previous_response"
    | "request_changed"
    | "socket_not_cached";
  finish: (options?: { keep?: boolean }) => void;
};

// Keep this credential-keyed SDK/normalized-replay cache separate from ChatGPT/Codex's
// raw-socket cache, which matches wire bodies and has sticky SSE fallback. Both use
// session-resource cleanup.
const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const degradedWebSocketConnections = new Map<string, { sessionId?: string; retryAt: number }>();

function isOfficialOpenAIResponsesBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return (
      url.protocol === "https:" &&
      url.hostname === "api.openai.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      path === "/v1"
    );
  } catch {
    return false;
  }
}
export function supportsNativeOpenAIResponsesWebSocket(params: {
  provider: string;
  api: string;
  baseUrl?: string;
}): boolean {
  return (
    params.provider.trim().toLowerCase() === "openai" &&
    params.api === "openai-responses" &&
    isOfficialOpenAIResponsesBaseUrl(params.baseUrl)
  );
}

function closeWebSocketSilently(socket: ResponsesWS, reason = "done"): void {
  try {
    socket.close({ code: 1000, reason });
  } catch {}
}

function invalidateOwnedWebSocketSession(
  cacheKey: string,
  entry: CachedWebSocketConnection,
  reason = "done",
): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  closeWebSocketSilently(entry.socket, reason);
  if (websocketSessionCache.get(cacheKey) === entry) {
    websocketSessionCache.delete(cacheKey);
  }
}

function scheduleSessionWebSocketExpiry(cacheKey: string, entry: CachedWebSocketConnection): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) {
      return;
    }
    invalidateOwnedWebSocketSession(cacheKey, entry, "idle_timeout");
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
  entry.idleTimer.unref?.();
}

type PreparedWebSocketConnection = {
  client: OpenAI;
  headers: Record<string, string>;
  identity: string;
};

function prepareWebSocketConnection(
  client: OpenAI,
  headers: Record<string, string> | undefined,
): PreparedWebSocketConnection {
  if (!isOfficialOpenAIResponsesBaseUrl(client.baseURL)) {
    throw new Error("OpenAI Responses WebSocket requires the official API endpoint");
  }
  if (typeof client.apiKey !== "string" || client.apiKey.length === 0) {
    throw new Error("OpenAI Responses WebSocket requires an API key");
  }
  const resolvedApiKey = getAiTransportHost().resolveSecretSentinel(client.apiKey);
  const resolvedHeaders = { ...resolveAiTransportHeaderSentinels(headers) };
  for (const key of Object.keys(resolvedHeaders)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "authorization" || normalizedKey === "traceparent") {
      delete resolvedHeaders[key];
    }
  }
  if (!resolvedApiKey) {
    throw new Error("OpenAI Responses WebSocket requires a resolved API key");
  }
  const resolvedClient = client.withOptions({ apiKey: resolvedApiKey });
  return {
    client: resolvedClient,
    headers: resolvedHeaders,
    identity: sha256Hex(
      JSON.stringify([
        resolvedApiKey,
        client.baseURL,
        Object.entries(resolvedHeaders).toSorted(([a], [b]) => a.localeCompare(b)),
      ]),
    ),
  };
}

function createWebSocket(
  connection: PreparedWebSocketConnection,
  onError: (socket: ResponsesWS) => void,
): ResponsesWS {
  // openai's dual ESM declaration paths give the same runtime client two nominal
  // private-field types under NodeNext resolution. The SDK constructor receives
  // the actual OpenAI instance; bridge only that declaration mismatch here.
  const socket = new ResponsesWS(
    connection.client as unknown as ConstructorParameters<typeof ResponsesWS>[0],
    { headers: connection.headers, maxQueueSize: 1 },
  );
  // The SDK async iterator removes its own listeners after every response while
  // cached sockets remain open. Keep one lifetime listener so an idle socket
  // failure is handled rather than becoming an unhandled SDK rejection.
  socket.on("error", () => onError(socket));
  return socket;
}

type WebSocketLease = {
  socket: ResponsesWS;
  iterator: AsyncIterator<ResponsesWebSocketStreamMessage>;
  entry?: CachedWebSocketConnection;
  reusedConnection: boolean;
  release: (options?: { keep?: boolean }) => void;
};

function createTransientWebSocketLease(connection: PreparedWebSocketConnection): WebSocketLease {
  const socket = createWebSocket(connection, (failedSocket) =>
    closeWebSocketSilently(failedSocket, "transport_error"),
  );
  return {
    socket,
    iterator: socket.stream(),
    reusedConnection: false,
    release: () => closeWebSocketSilently(socket),
  };
}

function createCachedWebSocketLease(
  cacheKey: string,
  entry: CachedWebSocketConnection,
  reusedConnection: boolean,
): WebSocketLease {
  entry.busy = true;
  return {
    socket: entry.socket,
    iterator: entry.socket.stream(),
    entry,
    reusedConnection,
    release: ({ keep } = {}) => {
      if (!keep || entry.socket.socket.readyState !== WEBSOCKET_OPEN_STATE) {
        invalidateOwnedWebSocketSession(cacheKey, entry);
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(cacheKey, entry);
    },
  };
}

function acquireWebSocket(
  params: {
    mode: OpenAIResponsesWebSocketMode;
    sessionId?: string;
  },
  connection: PreparedWebSocketConnection,
): WebSocketLease {
  const useCache = params.mode !== "websocket" && Boolean(params.sessionId);
  if (!useCache || !params.sessionId) {
    return createTransientWebSocketLease(connection);
  }

  const cacheKey = `${params.sessionId}\0${connection.identity}`;
  const cached = websocketSessionCache.get(cacheKey);
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (cached.busy) {
      return createTransientWebSocketLease(connection);
    }
    const expired = Date.now() - cached.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
    if (!expired && cached.socket.socket.readyState === WEBSOCKET_OPEN_STATE) {
      return createCachedWebSocketLease(cacheKey, cached, true);
    }
    invalidateOwnedWebSocketSession(cacheKey, cached, expired ? "connection_age_limit" : "done");
  }

  const socket = createWebSocket(connection, (failedSocket) => {
    const failedEntry = websocketSessionCache.get(cacheKey);
    if (failedEntry?.socket === failedSocket) {
      invalidateOwnedWebSocketSession(cacheKey, failedEntry, "transport_error");
    } else {
      closeWebSocketSilently(failedSocket, "transport_error");
    }
  });
  const entry = {
    socket,
    sessionId: params.sessionId,
    busy: true,
    createdAt: Date.now(),
  };
  websocketSessionCache.set(cacheKey, entry);
  return createCachedWebSocketLease(cacheKey, entry, false);
}

function requestWithoutInput(request: ResponsesWebSocketRequest): ResponsesWebSocketRequest {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = request;
  if (!rest.metadata || typeof rest.metadata !== "object" || Array.isArray(rest.metadata)) {
    return rest;
  }
  const metadata = Object.fromEntries(
    Object.entries(rest.metadata as Record<string, unknown>).filter(
      ([key]) => key !== "openclaw_turn_id" && key !== "openclaw_turn_attempt",
    ),
  );
  return { ...rest, metadata };
}

function sanitizeWebSocketRequest(request: Record<string, unknown>): ResponsesWebSocketRequest {
  const { stream: _stream, background: _background, ...websocketRequest } = request;
  return websocketRequest as ResponsesWebSocketRequest;
}

function normalizeAssistantReplayInput(input: ResponseInput): unknown[] {
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    const typedItem = item as unknown as Record<string, unknown>;
    if (typedItem.type === "reasoning") {
      return { type: "reasoning" };
    }
    if (
      typedItem.type !== "function_call" &&
      !(typedItem.type === "message" && typedItem.role === "assistant")
    ) {
      return item;
    }
    const { id: _id, status: _status, ...stableItem } = typedItem;
    return stableItem;
  });
}

function buildCachedWebSocketRequest(
  entry: CachedWebSocketConnection,
  request: ResponsesWebSocketRequest,
): Pick<OpenAIResponsesWebSocketStream, "continuationStatus" | "request"> {
  const continuation = entry.continuation;
  if (!continuation) {
    return { request, continuationStatus: "no_previous_response" };
  }
  const rejectContinuation = (
    continuationStatus: Exclude<
      OpenAIResponsesWebSocketStream["continuationStatus"],
      "continued" | "no_previous_response" | "socket_not_cached"
    >,
  ) => {
    entry.continuation = undefined;
    return { request, continuationStatus };
  };
  if (request.previous_response_id) {
    return rejectContinuation("explicit_previous_response_id");
  }
  if (
    JSON.stringify(requestWithoutInput(request)) !==
    JSON.stringify(requestWithoutInput(continuation.lastRequest))
  ) {
    return rejectContinuation("request_changed");
  }

  const currentInput = request.input ?? [];
  const previousInput = continuation.lastRequest.input ?? [];
  const baselineLength = previousInput.length + continuation.lastResponseItems.length;
  if (currentInput.length < baselineLength) {
    return rejectContinuation("history_shorter");
  }
  if (
    JSON.stringify(normalizeAssistantReplayInput(currentInput.slice(0, previousInput.length))) !==
      JSON.stringify(normalizeAssistantReplayInput(previousInput)) ||
    JSON.stringify(
      normalizeAssistantReplayInput(currentInput.slice(previousInput.length, baselineLength)),
    ) !== JSON.stringify(normalizeAssistantReplayInput(continuation.lastResponseItems))
  ) {
    return rejectContinuation("history_changed");
  }

  // Continuations are single-use. A terminal incomplete/error cannot leave an
  // older response id eligible for a later, unrelated turn.
  entry.continuation = undefined;
  return {
    request: {
      ...request,
      previous_response_id: continuation.lastResponseId,
      input: currentInput.slice(baselineLength),
    },
    continuationStatus: "continued",
  };
}

async function nextWebSocketMessage(
  iterator: AsyncIterator<ResponsesWebSocketStreamMessage>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<ResponsesWebSocketStreamMessage>> {
  if (!signal) {
    return iterator.next();
  }
  if (signal.aborted) {
    throw transportAbortError(signal);
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(transportAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function readServerEvent(
  message: ResponsesWebSocketStreamMessage,
): ResponsesServerEvent | undefined {
  if (message.type === "message") {
    return message.message;
  }
  if (message.type === "error") {
    throw new Error("OpenAI Responses WebSocket transport failed", { cause: message.error });
  }
  if (message.type === "close") {
    throw new Error(`OpenAI Responses WebSocket closed before completion (code ${message.code})`);
  }
  return undefined;
}

export function createOpenAIResponsesWebSocketStream(params: {
  client: OpenAI;
  request: Record<string, unknown>;
  mode: OpenAIResponsesWebSocketMode;
  sessionId?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  callerSignal?: AbortSignal;
  degradeCooldownMs?: number;
  resolveContinuationItems?: () => ResponseInput;
}): OpenAIResponsesWebSocketStream {
  const connection = prepareWebSocketConnection(params.client, params.headers);
  const fullRequest = sanitizeWebSocketRequest(params.request);
  const requestModel = typeof fullRequest.model === "string" ? fullRequest.model : "";
  const degradationKey = `${params.sessionId ?? ""}\0${connection.identity}\0${requestModel}`;
  const degraded = degradedWebSocketConnections.get(degradationKey);
  if (degraded && degraded.retryAt > Date.now()) {
    throw new OpenAIResponsesWebSocketPreDispatchError(
      new Error("OpenAI Responses WebSocket is cooling down after a transport failure"),
    );
  }
  degradedWebSocketConnections.delete(degradationKey);
  const markDegraded = () => {
    const cooldownMs = params.degradeCooldownMs;
    if (cooldownMs === undefined || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      return;
    }
    degradedWebSocketConnections.set(degradationKey, {
      sessionId: params.sessionId,
      retryAt: Date.now() + cooldownMs,
    });
  };
  let lease: ReturnType<typeof acquireWebSocket>;
  try {
    lease = acquireWebSocket(params, connection);
  } catch (error) {
    markDegraded();
    throw new OpenAIResponsesWebSocketPreDispatchError(error);
  }
  let prepared: ReturnType<typeof buildCachedWebSocketRequest>;
  try {
    prepared = lease.entry
      ? buildCachedWebSocketRequest(lease.entry, fullRequest)
      : {
          request: fullRequest,
          continuationStatus: "socket_not_cached" as const,
        };
  } catch (error) {
    void lease.iterator.return?.().catch(() => undefined);
    lease.release({ keep: false });
    throw error;
  }

  let streamStarted = false;
  let terminalResponseId: string | undefined;
  let terminalReceived = false;
  let released = false;
  const finish = ({ keep = true }: { keep?: boolean } = {}) => {
    if (released) {
      return;
    }
    released = true;
    try {
      if (keep && lease.entry && terminalResponseId && params.resolveContinuationItems) {
        lease.entry.continuation = {
          lastRequest: fullRequest,
          lastResponseId: terminalResponseId,
          lastResponseItems: params.resolveContinuationItems(),
        };
      }
    } catch (error) {
      if (lease.entry) {
        lease.entry.continuation = undefined;
      }
      lease.release({ keep: false });
      throw error;
    }
    lease.release({ keep });
  };
  const stream: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      if (streamStarted) {
        throw new Error("OpenAI Responses WebSocket stream can only be consumed once");
      }
      streamStarted = true;
      const iterator = lease.iterator;
      let requestDispatched = false;
      try {
        if (params.signal?.aborted) {
          throw transportAbortError(params.signal);
        }

        for (;;) {
          const next = await nextWebSocketMessage(iterator, params.signal);
          if (next.done) {
            throw new Error("OpenAI Responses WebSocket closed before a terminal response event");
          }
          if (next.value.type === "open") {
            if (!requestDispatched) {
              // Set before send because a thrown send cannot prove the frame stayed local.
              requestDispatched = true;
              lease.socket.send({
                ...prepared.request,
                type: "response.create",
              } as ResponsesClientEvent);
            }
            continue;
          }
          const event = readServerEvent(next.value);
          if (!event) {
            continue;
          }
          if (event.type === "response.failed") {
            throw new OpenAIResponsesWebSocketResponseFailedError(event.response.output.length > 0);
          }
          if (event.type === "response.completed" && typeof event.response.id === "string") {
            terminalResponseId = event.response.id;
          }
          terminalReceived =
            event.type === "response.completed" || event.type === "response.incomplete";
          yield event;
          if (terminalReceived) {
            degradedWebSocketConnections.delete(degradationKey);
            return;
          }
        }
      } catch (error) {
        if (lease.entry) {
          lease.entry.continuation = undefined;
        }
        if (!params.callerSignal?.aborted) {
          markDegraded();
        }
        if (!requestDispatched && !params.signal?.aborted) {
          throw new OpenAIResponsesWebSocketPreDispatchError(error);
        }
        if (
          !requestDispatched ||
          params.callerSignal?.aborted ||
          error instanceof OpenAIResponsesWebSocketResponseFailedError
        ) {
          throw error;
        }
        throw new OpenAIResponsesWebSocketPostDispatchError(error);
      } finally {
        await iterator.return?.().catch(() => undefined);
        if (!terminalReceived) {
          finish({ keep: false });
        }
      }
    },
  };

  return {
    stream,
    request: prepared.request,
    reusedConnection: lease.reusedConnection,
    continuationStatus: prepared.continuationStatus,
    finish,
  };
}

function closeOpenAIResponsesWebSocketSessions(sessionId?: string): void {
  for (const [cacheKey, entry] of websocketSessionCache) {
    if (sessionId && entry.sessionId !== sessionId) {
      continue;
    }
    invalidateOwnedWebSocketSession(cacheKey, entry, "session_cleanup");
  }
  for (const [key, entry] of degradedWebSocketConnections) {
    if (!sessionId || entry.sessionId === sessionId) {
      degradedWebSocketConnections.delete(key);
    }
  }
}

registerSessionResourceCleanup(closeOpenAIResponsesWebSocketSessions);
