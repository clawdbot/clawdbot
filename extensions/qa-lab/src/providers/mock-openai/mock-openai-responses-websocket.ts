import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";

export type QaMockResponsesDispatchResult = {
  events: StreamEvent[];
  failure?: {
    status: number;
    type: string;
    code?: string;
    message: string;
  };
  onResponseSent?: () => void;
  previewPauseMs?: number;
};

type QaMockResponsesWebSocketDispatch = (params: {
  body: Record<string, unknown>;
  raw: string;
}) => Promise<QaMockResponsesDispatchResult>;

type QaMockResponsesWebSocketHistory = {
  id: string;
  body: Record<string, unknown>;
  input: ResponsesInputItem[];
};

function readWebSocketText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function readWebSocketRequest(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sendWebSocketEvent(socket: WebSocket, event: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

/**
 * Give Codex the same Responses-over-WebSocket transport its built-in OpenAI
 * provider uses in production. An SSE-only mock makes each native turn pay
 * websocket reconnect/fallback retries before the real scenario even starts.
 */
export function attachQaMockResponsesWebSocketServer(params: {
  server: Server;
  dispatch: QaMockResponsesWebSocketDispatch;
}) {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });

  params.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/v1/responses") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (connection) => {
      webSocketServer.emit("connection", connection, request);
    });
  });

  webSocketServer.on("connection", (socket: WebSocket) => {
    let cachedResponse: QaMockResponsesWebSocketHistory | undefined;
    let warmupOrdinal = 0;
    let sequenceNumber = 0;
    let pending = Promise.resolve();
    const sendEvent = (event: Record<string, unknown>) => {
      sendWebSocketEvent(socket, { ...event, sequence_number: sequenceNumber++ });
    };

    socket.on("error", () => {
      // A disconnected client must not crash or outlive the private mock.
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      pending = pending
        .then(async () => {
          // Responses stream sequence numbers describe one response, not
          // all responses that happen to reuse the same WebSocket.
          sequenceNumber = 0;
          const raw = readWebSocketText(data);
          const request = isBinary ? undefined : readWebSocketRequest(raw);
          if (!request || request.type !== "response.create") {
            sendEvent({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                message: "Expected a JSON response.create request.",
              },
            });
            return;
          }

          const previousResponseId =
            typeof request.previous_response_id === "string"
              ? request.previous_response_id
              : undefined;
          if (previousResponseId && cachedResponse?.id !== previousResponseId) {
            sendEvent({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                code: "previous_response_not_found",
                message: "The previous response was not found on this connection.",
              },
            });
            return;
          }
          const previousResponse = previousResponseId ? cachedResponse : undefined;
          const previousInput = previousResponse?.input ?? [];
          const nextInput = Array.isArray(request.input)
            ? (request.input as ResponsesInputItem[])
            : [];
          const inheritedRequest = previousResponse ? { ...previousResponse.body } : {};
          // These control fields belong to one frame; model, instructions,
          // tool definitions, and other prompt context carry across deltas.
          delete inheritedRequest.type;
          delete inheritedRequest.previous_response_id;
          delete inheritedRequest.generate;
          delete inheritedRequest.input;
          const body: Record<string, unknown> & { input: ResponsesInputItem[] } = {
            ...inheritedRequest,
            ...request,
            input: [...previousInput, ...nextInput],
          };

          if (request.generate === false) {
            const id = `resp_qa_ws_warmup_${++warmupOrdinal}`;
            const createdAt = Math.floor(Date.now() / 1_000);
            const model = typeof body.model === "string" ? body.model : "";
            sendEvent({
              type: "response.created",
              response: {
                id,
                object: "response",
                created_at: createdAt,
                model,
                status: "in_progress",
                output: [],
              },
            });
            sendEvent({
              type: "response.completed",
              response: {
                id,
                object: "response",
                created_at: createdAt,
                model,
                status: "completed",
                output: [],
                usage: {
                  input_tokens: 0,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens: 0,
                  output_tokens_details: { reasoning_tokens: 0 },
                  total_tokens: 0,
                },
              },
            });
            // Codex's real first request often sends no input at all: its
            // previous_response_id points at this prompt-bearing warmup.
            cachedResponse = { id, body, input: body.input };
            return;
          }

          // Codex sends only the delta after a cached response; scenario and
          // debug matching need the complete prompt and inherited tool surface.
          const dispatched = await params.dispatch({ body, raw: JSON.stringify(body) });
          if (dispatched.failure) {
            // A failed continuation invalidates the connection's ephemeral
            // store=false response; Codex must retry with a full new request.
            cachedResponse = undefined;
            sendEvent({
              type: "error",
              status: dispatched.failure.status,
              error: {
                type: dispatched.failure.type,
                ...(dispatched.failure.code ? { code: dispatched.failure.code } : {}),
                message: dispatched.failure.message,
              },
            });
            return;
          }
          const { events } = dispatched;
          const completion = events.find((event) => event.type === "response.completed");
          if (completion?.type === "response.completed") {
            if (!events.some((event) => event.type === "response.created")) {
              sendEvent({
                type: "response.created",
                response: {
                  id: completion.response.id,
                  object: "response",
                  created_at: Math.floor(Date.now() / 1_000),
                  model: typeof body.model === "string" ? body.model : "",
                  status: "in_progress",
                  output: [],
                },
              });
            }
            cachedResponse = {
              id: completion.response.id,
              body,
              input: [...body.input, ...completion.response.output],
            };
          }
          for (const event of events) {
            if (dispatched.previewPauseMs && event.type === "response.output_text.done") {
              await sleep(dispatched.previewPauseMs);
            }
            sendEvent(event);
          }
          dispatched.onResponseSent?.();
        })
        .catch(() => {
          cachedResponse = undefined;
          sequenceNumber = 0;
          sendEvent({
            type: "error",
            status: 500,
            error: {
              type: "server_error",
              message: "Mock Responses WebSocket dispatch failed.",
            },
          });
        });
    });
  });

  return {
    async close(): Promise<void> {
      for (const socket of webSocketServer.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
