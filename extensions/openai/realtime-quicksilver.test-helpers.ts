import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { vi } from "vitest";
import { createOpenAIQuicksilverBrowserSessionBroker } from "./realtime-quicksilver-session.js";

export class FakeSocket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 0;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  constructor(autoEvent: "open" | "error" | "close" | "manual" = "open") {
    super();
    queueMicrotask(() => {
      if (autoEvent === "open") {
        this.readyState = 1;
        this.emit("open");
      } else if (autoEvent === "error") {
        this.emit("error", new Error("transient sideband failure"));
      } else if (autoEvent === "close") {
        this.emit("close");
      }
    });
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }
}

export function createRequest(params: {
  method?: string;
  token?: string;
  origin?: string;
  host?: string;
  contentType?: string;
  body?: string;
}): IncomingMessage {
  return Object.assign(Readable.from([params.body ?? "v=offer\r\n"]), {
    method: params.method ?? "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...(params.contentType === undefined
        ? { "content-type": "application/sdp" }
        : params.contentType
          ? { "content-type": params.contentType }
          : {}),
      ...(params.origin ? { origin: params.origin } : {}),
      ...(params.host ? { host: params.host } : {}),
    },
  }) as unknown as IncomingMessage;
}

export function createPreflightRequest(origin: string, host?: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "OPTIONS",
    headers: {
      origin,
      ...(host ? { host } : {}),
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
      "access-control-request-private-network": "true",
    },
  }) as unknown as IncomingMessage;
}

export function createResponseHarness(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  readBody: () => string;
} {
  let body = "";
  const setHeader = vi.fn();
  const end = vi.fn((value?: string) => {
    body = value ?? "";
    queueMicrotask(() => res.emit("finish"));
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader,
    end,
  }) as unknown as ServerResponse;
  return { res, end, setHeader, readBody: () => body };
}

export function createCallResponse(answer = "v=answer\r\n", callId = "rtc_test"): Response {
  return new Response(answer, {
    status: 201,
    headers: { Location: `/v1/live/${callId}?source=test` },
  });
}

export function parseSent(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

export function emitSideband(socket: FakeSocket, payload: unknown, isBinary = false): void {
  socket.emit("message", Buffer.from(JSON.stringify(payload)), isBinary);
}

export function createBroker(params?: {
  fetchImpl?: typeof fetch;
  runAgentConsult?: (params: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
  socketFactory?: (attempt: number) => FakeSocket;
}) {
  const sockets: FakeSocket[] = [];
  const socketRequests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const realtime = createOpenAIQuicksilverBrowserSessionBroker({
    getConfig: () => ({
      gateway: { controlUi: { allowedOrigins: ["https://control.example"] } },
    }),
    logger,
    fetchImpl: params?.fetchImpl ?? vi.fn(async () => createCallResponse()),
    webSocketFactory: (url, options) => {
      const socket = params?.socketFactory?.(sockets.length) ?? new FakeSocket();
      sockets.push(socket);
      socketRequests.push({
        url,
        headers: options.headers as Record<string, string> | undefined,
      });
      return socket;
    },
  });
  const runAgentConsult = params?.runAgentConsult ?? vi.fn(async () => ({ text: "Done" }));
  return { realtime, sockets, socketRequests, logger, runAgentConsult };
}
