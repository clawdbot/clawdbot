import {
  SSEClientTransport,
  SseError,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const STREAM_RETRY_EXHAUSTED_RE = /^Maximum reconnection attempts \(\d+\) exceeded\.$/;
const SESSION_TERMINATION_TIMEOUT_MS = 5_000;

class McpHttpResponseTooLargeError extends Error {
  readonly code = "MCP_HTTP_RESPONSE_TOO_LARGE";

  constructor(unit: "HTTP response" | "SSE event") {
    super(`MCP ${unit} exceeds ${STDIO_DEFAULT_MAX_BUFFER_SIZE} bytes`);
    this.name = "McpHttpResponseTooLargeError";
  }
}

function isMcpSseEventTooLargeError(error: Error): boolean {
  return error.message.includes(`MCP SSE event exceeds ${STDIO_DEFAULT_MAX_BUFFER_SIZE} bytes`);
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

function limitMcpResponseStream<Chunk extends Uint8Array>(
  body: ReadableStream<Chunk>,
  eventStream: boolean,
): ReadableStream<Chunk> {
  // Match the SDK stdio cap per MCP message. Resetting at each SSE event keeps
  // long-lived streams healthy without allowing one event to grow unbounded.
  let messageBytes = 0;
  let retainedEventBytes = 0;
  let lineBytes = 0;
  let lineIsComment = false;
  let previousByteWasCr = false;

  const checkEventLimit = () => {
    if (retainedEventBytes + lineBytes > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
      throw new McpHttpResponseTooLargeError("SSE event");
    }
  };
  const finishEventLine = () => {
    if (lineBytes === 0) {
      retainedEventBytes = 0;
    } else if (!lineIsComment) {
      retainedEventBytes += lineBytes + 1;
    }
    lineBytes = 0;
    lineIsComment = false;
    checkEventLimit();
  };

  return body.pipeThrough(
    new TransformStream<Chunk, Chunk>({
      transform(chunk, controller) {
        if (!eventStream) {
          messageBytes += chunk.byteLength;
          if (messageBytes > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
            throw new McpHttpResponseTooLargeError("HTTP response");
          }
          controller.enqueue(chunk);
          return;
        }

        for (const byte of chunk) {
          if (previousByteWasCr && byte === 0x0a) {
            previousByteWasCr = false;
            continue;
          }
          previousByteWasCr = false;
          if (byte === 0x0d || byte === 0x0a) {
            finishEventLine();
            previousByteWasCr = byte === 0x0d;
            continue;
          }
          if (lineBytes === 0) {
            lineIsComment = byte === 0x3a;
          }
          lineBytes += 1;
          checkEventLimit();
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function limitMcpHttpResponse(response: Response): Response {
  if (!response.body) {
    return response;
  }
  return new Response(limitMcpResponseStream(response.body, isEventStreamResponse(response)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function withMcpHttpResponseLimits(fetchFn: FetchLike): FetchLike {
  return async (input, init) => limitMcpHttpResponse(await fetchFn(input, init));
}

type EventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]
>;
type EventSourceResponse = Awaited<ReturnType<EventSourceFetch>>;

function toEventSourceByteStream(
  body: NonNullable<EventSourceResponse["body"]>,
): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) {
    return body;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      if (!(result.value instanceof Uint8Array)) {
        await reader.cancel();
        throw new TypeError("MCP SSE response body must contain byte chunks");
      }
      controller.enqueue(new Uint8Array(result.value));
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

function limitMcpEventSourceResponse(response: EventSourceResponse): Response {
  // EventSource needs redirect and auth response metadata. Replace only the
  // body so the size boundary does not change its connection behavior.
  if (!response.body && response instanceof Response) {
    return response;
  }
  const headers = response instanceof Response ? response.headers : new Headers();
  if (!(response instanceof Response)) {
    for (const name of ["content-type", "www-authenticate"]) {
      const value = response.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
  }
  const body = response.body
    ? limitMcpResponseStream(toEventSourceByteStream(response.body), true)
    : null;
  const limitedResponse = new Response(body, {
    status: response.status,
    ...(response instanceof Response ? { statusText: response.statusText } : {}),
    headers,
  });
  Object.defineProperties(limitedResponse, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return limitedResponse;
}

abstract class OpenClawMcpHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  protected closed = false;
  private closeEmitted = false;

  protected emitClose(): void {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.onclose?.();
  }

  protected emitError(error: Error): void {
    if (!this.closed) {
      this.onerror?.(error);
    }
  }

  abstract start(): Promise<void>;
  abstract close(): Promise<void>;
  abstract send(message: JSONRPCMessage): Promise<void>;
}

/** Converts legacy SSE terminal HTTP failures into the lifecycle close the SDK omits. */
export class OpenClawSSEClientTransport extends OpenClawMcpHttpTransport {
  private readonly transport: SSEClientTransport;

  constructor(url: URL, options?: SSEClientTransportOptions) {
    super();
    const baseFetch = options?.fetch ?? fetch;
    const limitedFetch = withMcpHttpResponseLimits(baseFetch);
    const eventSourceInit = options?.eventSourceInit;
    const configuredEventSourceFetch = eventSourceInit?.fetch;
    this.transport = new SSEClientTransport(url, {
      ...options,
      fetch: limitedFetch,
      eventSourceInit: {
        ...eventSourceInit,
        fetch: async (eventUrl, init) => {
          const raw = configuredEventSourceFetch
            ? await configuredEventSourceFetch(eventUrl, init)
            : await baseFetch(eventUrl, init);
          return limitMcpEventSourceResponse(raw);
        },
      },
    });
  }

  async start(): Promise<void> {
    // The SDK transport exposes callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onmessage = (message) => this.onmessage?.(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onclose = () => this.emitClose();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onerror = (error) => {
      this.emitError(error);
      if (
        isMcpSseEventTooLargeError(error) ||
        (error instanceof SseError && error.code !== undefined)
      ) {
        void this.close();
        // EventSource schedules reconnect after its error callback returns.
        // Close again on the next turn so that new timer cannot survive.
        setTimeout(() => void this.transport.close(), 0).unref?.();
      }
    };
    await this.transport.start();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.transport.close();
    this.emitClose();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error("MCP SSE transport is closed");
    }
    await this.transport.send(message);
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion(version);
  }
}

type OpenClawStreamableHttpOptions = StreamableHTTPClientTransportOptions & {
  fetch?: FetchLike;
  requestInit?: RequestInit;
};

/** Owns Streamable HTTP notification recovery and stateful cleanup around SDK 1.30.0. */
export class OpenClawStreamableHTTPClientTransport extends OpenClawMcpHttpTransport {
  private readonly transport: StreamableHTTPClientTransport;
  private readonly url: URL;
  private readonly cleanupFetch: FetchLike;
  private readonly requestInit?: RequestInit;
  private pendingExpiredNotificationGet = false;
  private terminatedSessionId?: string;

  constructor(url: URL, options: OpenClawStreamableHttpOptions = {}) {
    super();
    this.url = url;
    this.cleanupFetch = options.fetch ?? fetch;
    this.requestInit = options.requestInit;
    const runtimeFetch: FetchLike = async (input, init) => {
      if (this.closed) {
        throw new Error("MCP Streamable HTTP transport is closed");
      }
      const response = limitMcpHttpResponse(await this.cleanupFetch(input, init));
      if (init?.method === "GET" && response.status === 404 && this.sessionId !== undefined) {
        this.pendingExpiredNotificationGet = true;
      }
      return response;
    };
    this.transport = new StreamableHTTPClientTransport(url, {
      ...options,
      fetch: runtimeFetch,
    });
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  get protocolVersion(): string | undefined {
    return this.transport.protocolVersion;
  }

  async start(): Promise<void> {
    // The SDK transport exposes callback properties rather than EventTarget listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onmessage = (message) => this.onmessage?.(message);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onclose = () => this.emitClose();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.transport.onerror = (error) => {
      if (this.closed) {
        // SDK reconnect callbacks can finish after close() cleared their old timer.
        // Defer a second close so any timer armed later in that callback is cancelled.
        setTimeout(() => void this.transport.close(), 0).unref?.();
        return;
      }
      this.emitError(error);
      const sessionExpired =
        this.pendingExpiredNotificationGet &&
        error instanceof StreamableHTTPError &&
        error.code === 404;
      if (sessionExpired) {
        this.pendingExpiredNotificationGet = false;
      }
      if (
        isMcpSseEventTooLargeError(error) ||
        sessionExpired ||
        STREAM_RETRY_EXHAUSTED_RE.test(error.message)
      ) {
        void this.close();
      }
    };
    await this.transport.start();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.transport.close();
    this.emitClose();
  }

  async send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    await this.transport.send(message, options);
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion(version);
  }

  /** Uses a fresh request signal because failed initialization makes the SDK's signal unusable. */
  async terminateSession(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || sessionId === this.terminatedSessionId) {
      return;
    }
    const headers = new Headers(this.requestInit?.headers);
    headers.set("mcp-session-id", sessionId);
    if (this.protocolVersion) {
      headers.set("mcp-protocol-version", this.protocolVersion);
    }
    const response = await this.cleanupFetch(this.url, {
      ...this.requestInit,
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(SESSION_TERMINATION_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 405) {
      throw new StreamableHTTPError(
        response.status,
        `Failed to terminate session: ${response.statusText}`,
      );
    }
    this.terminatedSessionId = sessionId;
  }
}
