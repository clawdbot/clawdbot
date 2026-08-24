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
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const STREAM_RETRY_EXHAUSTED_RE = /^Maximum reconnection attempts \(\d+\) exceeded\.$/;
const SESSION_TERMINATION_TIMEOUT_MS = 5_000;

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
    this.transport = new SSEClientTransport(url, options);
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
      if (error instanceof SseError && error.code !== undefined) {
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
      const response = await this.cleanupFetch(input, init);
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
      if (sessionExpired || STREAM_RETRY_EXHAUSTED_RE.test(error.message)) {
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
