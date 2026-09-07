import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type OpenAI from "openai";
import type {
  ResponseInput,
  ResponsesClientEvent,
  ResponsesServerEvent,
} from "openai/resources/responses/responses.js";
import { ResponsesWS } from "openai/resources/responses/ws.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import type { StreamOptions, UserMessage } from "../types.js";
import {
  resolveResponsesContinuationRequest,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
  type ResponsesContinuationStatus,
} from "./openai-responses-continuation.js";
import {
  parseOpenAIResponsesWebSocketServerError,
  OpenAIResponsesWebSocketPostDispatchError,
  OpenAIResponsesWebSocketPreDispatchError,
  OpenAIResponsesWebSocketSafeRetryError,
} from "./openai-responses-contracts.js";
import {
  responsesInputFingerprint,
  type ResponsesInputReplay,
} from "./openai-responses-input-replay.js";
import { createResponsesSteering, omitAcceptedSteering } from "./openai-responses-steering.js";
import { transportAbortError } from "./transport-stream-shared.js";
import { sha256Hex } from "./transport-utils.js";

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const WEBSOCKET_OPEN_STATE = 1;

type CachedWebSocketConnection = {
  socket: ResponsesWS;
  sessionId: string;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: ResponsesContinuationState;
  steeringContinuation?: SteeringContinuation;
};

type ResponsesWebSocketStreamMessage =
  ReturnType<ResponsesWS["stream"]> extends AsyncIterable<infer T> ? T : never;

type SteeringContinuation = {
  iterator: AsyncIterator<ResponsesWebSocketStreamMessage>;
  buffered: ResponsesWebSocketStreamMessage[];
  acceptedInput: ResponseInput;
  requiresInput: boolean;
  steering: ReturnType<typeof createResponsesSteering>;
  instructions: unknown;
  tools: unknown;
};

export type OpenAIResponsesWebSocketMode = "websocket" | "websocket-cached" | "auto";

type OpenAIResponsesWebSocketStream = {
  stream: AsyncIterable<unknown>;
  request: ResponsesContinuationRequest;
  reusedConnection: boolean;
  continuationStatus: ResponsesContinuationStatus | "socket_not_cached";
  inputReplay?: ResponsesInputReplay;
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
    return (
      url.origin === "https://api.openai.com" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.replace(/\/+$/, "") === "/v1"
    );
  } catch {
    return false;
  }
}
export function supportsNativeOpenAIResponsesEndpoint(params: {
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
  entry.steeringContinuation?.steering.close(new Error("Responses steering connection closed"));
  void entry.steeringContinuation?.iterator.return?.().catch(() => undefined);
  entry.steeringContinuation = undefined;
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
  steeringContinuation?: SteeringContinuation;
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
  const steeringContinuation = entry.steeringContinuation;
  entry.steeringContinuation = undefined;
  return {
    socket: entry.socket,
    iterator: steeringContinuation?.iterator ?? entry.socket.stream(),
    entry,
    reusedConnection,
    steeringContinuation,
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

function sanitizeWebSocketRequest(request: Record<string, unknown>): ResponsesContinuationRequest {
  const { stream: _stream, background: _background, ...websocketRequest } = request;
  return websocketRequest as ResponsesContinuationRequest;
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
    throw (
      parseOpenAIResponsesWebSocketServerError(message.error) ??
      new Error("OpenAI Responses WebSocket transport failed", { cause: message.error })
    );
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
  onActiveResponse?: StreamOptions["onActiveResponse"];
  steeringInput?: (messages: readonly UserMessage[]) => ResponseInput | Promise<ResponseInput>;
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
  let prepared: Omit<ReturnType<typeof resolveResponsesContinuationRequest>, "continuationStatus"> &
    Pick<OpenAIResponsesWebSocketStream, "continuationStatus">;
  const resumedSteering = lease.steeringContinuation;
  const steeringMode = resumedSteering
    ? resumedSteering.requiresInput
      ? "required-input"
      : "automatic"
    : undefined;
  try {
    const continuation = lease.entry?.continuation;
    if (continuation && lease.entry) {
      // Consume before dispatch so incomplete/error terminals cannot reuse stale state.
      lease.entry.continuation = undefined;
      prepared = resolveResponsesContinuationRequest(continuation, fullRequest, steeringMode);
    } else {
      prepared = {
        request: fullRequest,
        continuationStatus: lease.entry ? "no_previous_response" : "socket_not_cached",
      };
    }
  } catch (error) {
    void lease.iterator.return?.().catch(() => undefined);
    lease.release({ keep: false });
    throw error;
  }

  let streamStarted = false;
  let terminalResponse:
    | Extract<ResponsesServerEvent, { type: "response.completed" }>["response"]
    | undefined;
  let terminalReceived = false;
  let released = false;
  let retainIterator = false;
  let deferredInput = false;
  let inputReplay: ResponsesInputReplay | undefined;
  if (resumedSteering) {
    try {
      if (prepared.continuationStatus !== "continued" || !prepared.request.previous_response_id) {
        throw new Error("Responses steering continuation changed its request or history");
      }
      const input = omitAcceptedSteering(
        prepared.request.input ?? [],
        resumedSteering.acceptedInput,
      );
      if (
        !resumedSteering.requiresInput &&
        (stableStringify(fullRequest.instructions) !==
          stableStringify(resumedSteering.instructions) ||
          stableStringify(fullRequest.tools) !== stableStringify(resumedSteering.tools))
      ) {
        throw new Error(
          "Responses automatic steering continuation cannot change instructions or tools",
        );
      }
      const baseline = prepared.fullRequest ?? fullRequest;
      const priorLength = (baseline.input?.length ?? 0) - (prepared.request.input?.length ?? 0);
      const fingerprints = input.map(responsesInputFingerprint);
      if (fingerprints.length > 0) {
        inputReplay = {
          afterResponseId: prepared.request.previous_response_id,
          before: resumedSteering.requiresInput ? fingerprints : [],
          after: resumedSteering.requiresInput ? [] : fingerprints,
        };
      }
      // The server prepends accepted steering. An automatic response receives
      // none of the later local input; transcript replay owns its eventual delivery.
      const delivered = resumedSteering.requiresInput ? input : [];
      prepared.fullRequest = {
        ...baseline,
        input: [
          ...(baseline.input ?? []).slice(0, priorLength),
          ...resumedSteering.acceptedInput,
          ...delivered,
        ],
      };
      prepared.request = { ...prepared.request, input: delivered };
      deferredInput = !resumedSteering.requiresInput && input.length > 0;
    } catch (error) {
      void lease.iterator.return?.().catch(() => undefined);
      lease.release({ keep: false });
      throw new OpenAIResponsesWebSocketPostDispatchError(error);
    }
  }
  const steering =
    lease.entry && params.onActiveResponse && params.steeringInput
      ? createResponsesSteering({
          onActiveResponse: params.onActiveResponse,
          toInput: params.steeringInput,
          send: (event) => lease.socket.sendRaw(JSON.stringify(event)),
          needsContinuation: () => deferredInput,
          assertActive: () => {
            if (released || terminalReceived || params.signal?.aborted) {
              throw new Error("Responses steering is no longer active");
            }
          },
        })
      : undefined;
  const finish = ({ keep = true }: { keep?: boolean } = {}) => {
    if (released) {
      return;
    }
    released = true;
    if (keep && lease.entry && terminalResponse) {
      lease.entry.continuation = {
        lastRequest: prepared.fullRequest ?? fullRequest,
        lastResponseId: terminalResponse.id,
        lastResponseItems: terminalResponse.output,
      };
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

        // An automatic continuation may start immediately after the old terminal.
        // Retain the SDK iterator across the handoff so those events cannot be lost.
        if (resumedSteering) {
          requestDispatched = true;
          if (resumedSteering.requiresInput) {
            lease.socket.send({
              ...prepared.request,
              type: "response.create",
            } as ResponsesClientEvent); // SAFETY: Valid create request with newer SDK input items.
          }
        }
        for (;;) {
          const buffered = resumedSteering?.buffered.shift();
          const next = buffered
            ? { value: buffered, done: false }
            : await nextWebSocketMessage(iterator, params.signal);
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
          if (
            isRecord(event) &&
            typeof event.type === "string" &&
            event.type.startsWith("response.steer.")
          ) {
            const owner =
              isRecord(event.steer) && event.steer.previous_response_id === steering?.responseId
                ? steering
                : (resumedSteering?.steering ?? steering);
            if (owner?.handle(event)) {
              continue;
            }
          }
          steering?.handle(event);
          if (event.type === "response.completed") {
            terminalResponse = event.response;
          }
          terminalReceived =
            event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed";
          if (terminalReceived) {
            steering?.seal();
            if (event.type === "response.failed") {
              steering?.close(new Error("Responses failed before steering could be applied"));
            }
            const continuationBuffer: ResponsesWebSocketStreamMessage[] = [];
            for (;;) {
              if (!steering?.pending) {
                break;
              }
              const acknowledgement = await nextWebSocketMessage(iterator, params.signal);
              if (acknowledgement.done) {
                throw new Error("Responses closed before acknowledging steering");
              }
              const acknowledgedEvent = readServerEvent(acknowledgement.value);
              if (!steering.handle(acknowledgedEvent)) {
                continuationBuffer.push(acknowledgement.value);
              }
            }
            const acceptedInput = steering?.acceptedInput ?? [];
            const isSteered =
              event.type === "response.incomplete" &&
              isRecord(event.response.incomplete_details) &&
              event.response.incomplete_details.reason === "steered";
            if (
              lease.entry &&
              steering &&
              acceptedInput.length > 0 &&
              (event.type === "response.completed" || isSteered)
            ) {
              if (event.type === "response.incomplete") {
                terminalResponse = event.response;
              }
              lease.entry.steeringContinuation = {
                iterator,
                buffered: continuationBuffer,
                acceptedInput,
                requiresInput: (terminalResponse?.output ?? []).some(
                  (item) =>
                    ((item.type === "function_call" || item.type === "custom_tool_call") &&
                      !(isRecord(item) && item.async === true)) ||
                    item.type === "mcp_approval_request",
                ),
                steering,
                instructions: fullRequest.instructions,
                tools: fullRequest.tools,
              };
              retainIterator = true;
              if (isSteered) {
                // A steered response is a successful segment, not a failed agent turn.
                // The next stream consumes its already-running server continuation.
                yield {
                  ...event,
                  type: "response.completed",
                  response: { ...event.response, status: "completed", incomplete_details: null },
                };
                return;
              }
            }
          }
          yield event;
          if (terminalReceived) {
            degradedWebSocketConnections.delete(degradationKey);
            return;
          }
        }
      } catch (error) {
        const steeringDispatched = Boolean(
          steering?.pending || steering?.acceptedInput.length || resumedSteering,
        );
        steering?.close(error instanceof Error ? error : new Error("Responses steering failed"));
        if (lease.entry) {
          lease.entry.continuation = undefined;
        }
        const safeRetry =
          error instanceof OpenAIResponsesWebSocketSafeRetryError && !steeringDispatched;
        if (!params.callerSignal?.aborted && !safeRetry) {
          markDegraded();
        }
        if (!requestDispatched && !params.signal?.aborted) {
          throw new OpenAIResponsesWebSocketPreDispatchError(error);
        }
        if (!requestDispatched || params.callerSignal?.aborted || safeRetry) {
          throw error;
        }
        throw new OpenAIResponsesWebSocketPostDispatchError(error);
      } finally {
        steering?.seal();
        if (!retainIterator) {
          steering?.close(new Error("Responses stream ended before steering was confirmed"));
          await iterator.return?.().catch(() => undefined);
        }
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
    inputReplay,
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
