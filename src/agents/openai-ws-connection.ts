import { randomUUID } from "node:crypto";
/**
 * OpenAI WebSocket Connection Manager
 *
 * Manages a persistent WebSocket connection to the OpenAI Responses API
 * (wss://api.openai.com/v1/responses) for multi-turn tool-call workflows.
 *
 * Features:
 * - Auto-reconnect with exponential backoff (max 5 retries: 1s/2s/4s/8s/16s)
 * - Tracks previous_response_id per connection for incremental turns
 * - Warm-up support (generate: false) to pre-load the connection
 * - Typed WebSocket event definitions matching the Responses API SSE spec
 *
 * @see https://developers.openai.com/api/docs/guides/websocket-mode
 */
import { EventEmitter } from "node:events";
import WebSocket, { type ClientOptions } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { createDebugProxyWebSocketAgent, resolveDebugProxySettings } from "../proxy-capture/env.js";
import { captureWsEvent } from "../proxy-capture/runtime.js";
import { buildOpenAIWebSocketWarmUpPayload } from "./openai-ws-request.js";
import type {
  ClientEvent,
  FunctionToolDefinition,
  InputItem,
  OpenAIResponsesAssistantPhase,
} from "./openai-ws-types.js";
import {
  buildProviderRequestTlsClientOptions,
  resolveProviderRequestPolicyConfig,
  type ModelProviderRequestTransportOverrides,
} from "./provider-request-config.js";

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Event Types (Server → Client)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  model: string;
  output: OutputItem[];
  usage?: UsageInfo;
  error?: { code: string; message: string };
  incomplete_details?: { reason?: string };
}

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
}

export type OutputItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      content: Array<{ type: "output_text"; text: string }>;
      phase?: OpenAIResponsesAssistantPhase;
      status?: "in_progress" | "completed";
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status?: "in_progress" | "completed";
    }
  | {
      type: "reasoning" | `reasoning.${string}`;
      id: string;
      content?: unknown;
      encrypted_content?: string;
      summary?: unknown;
    };

export interface ResponseCreatedEvent {
  type: "response.created";
  response: ResponseObject;
}

export interface ResponseInProgressEvent {
  type: "response.in_progress";
  response: ResponseObject;
}

export interface ResponseCompletedEvent {
  type: "response.completed";
  response: ResponseObject;
}

export interface ResponseFailedEvent {
  type: "response.failed";
  response: ResponseObject;
}

export interface OutputItemAddedEvent {
  type: "response.output_item.added";
  output_index: number;
  item: OutputItem;
}

export interface OutputItemDoneEvent {
  type: "response.output_item.done";
  output_index: number;
  item: OutputItem;
}

export interface ContentPartAddedEvent {
  type: "response.content_part.added";
  item_id: string;
  output_index: number;
  content_index: number;
  part: { type: "output_text"; text: string };
}

export interface ContentPartDoneEvent {
  type: "response.content_part.done";
  item_id: string;
  output_index: number;
  content_index: number;
  part: { type: "output_text"; text: string };
}

export interface OutputTextDeltaEvent {
  type: "response.output_text.delta";
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface OutputTextDoneEvent {
  type: "response.output_text.done";
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface FunctionCallArgumentsDeltaEvent {
  type: "response.function_call_arguments.delta";
  item_id: string;
  output_index: number;
  call_id: string;
  delta: string;
}

export interface FunctionCallArgumentsDoneEvent {
  type: "response.function_call_arguments.done";
  item_id: string;
  output_index: number;
  call_id: string;
  arguments: string;
}

export interface RateLimitUpdatedEvent {
  type: "rate_limits.updated";
  rate_limits: Array<{
    name: string;
    limit: number;
    remaining: number;
    reset_seconds: number;
  }>;
}

export interface ErrorEvent {
  type: "error";
  status?: number;
  code?: string;
  message?: string;
  param?: string;
  error?: {
    type?: string;
    code?: string;
    message?: string;
    param?: string;
  };
}

export type OpenAIWebSocketEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | RateLimitUpdatedEvent
  | ErrorEvent;

export type {
  ClientEvent,
  ContentPart,
  FunctionToolDefinition,
  InputItem,
  OpenAIResponsesAssistantPhase,
  ResponseCreateEvent,
  ToolChoice,
  WarmUpEvent,
} from "./openai-ws-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Connection Manager
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const MAX_RETRIES = 5;
/** Backoff delays in ms: 1s, 2s, 4s, 8s, 16s */
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

export interface OpenAIWebSocketManagerOptions {
  /** Override the default WebSocket URL (useful for testing) */
  url?: string;
  /** Maximum number of reconnect attempts (default: 5) */
  maxRetries?: number;
  /** Custom backoff delays in ms (default: [1000, 2000, 4000, 8000, 16000]) */
  backoffDelaysMs?: readonly number[];
  /** Custom socket factory for tests. */
  socketFactory?: (url: string, options: ClientOptions) => WebSocket;
  /** Extra headers merged into the initial WebSocket handshake request. */
  headers?: Record<string, string>;
  /** Optional transport overrides for provider-owned auth or TLS wiring. */
  request?: ModelProviderRequestTransportOverrides;
}

export type OpenAIWebSocketConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface OpenAIWebSocketCloseInfo {
  code: number;
  reason: string;
  retryable: boolean;
}

type InternalEvents = {
  message: [event: OpenAIWebSocketEvent];
  open: [];
  close: [code: number, reason: string];
  error: [err: Error];
};

/**
 * Manages a persistent WebSocket connection to the OpenAI Responses API.
 *
 * Usage:
 * ```ts
 * const manager = new OpenAIWebSocketManager();
 * await manager.connect(apiKey);
 *
 * manager.onMessage((event) => {
 *   if (event.type === "response.completed") {
 *     console.log("Response ID:", event.response.id);
 *   }
 * });
 *
 * manager.send({ type: "response.create", model: "gpt-5.4", input: [...] });
 * ```
 */
export class OpenAIWebSocketManager extends EventEmitter<InternalEvents> {
  private ws: WebSocket | null = null;
  private apiKey: string | null = null;
  private retryCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  /** The ID of the most recent completed response on this connection. */
  private _previousResponseId: string | null = null;
  private _connectionState: OpenAIWebSocketConnectionState = "idle";
  private _lastCloseInfo: OpenAIWebSocketCloseInfo | null = null;

  private readonly wsUrl: string;
  private readonly maxRetries: number;
  private readonly backoffDelaysMs: readonly number[];
  private readonly socketFactory: (url: string, options: ClientOptions) => WebSocket;
  private readonly headers?: Record<string, string>;
  private readonly request?: ModelProviderRequestTransportOverrides;
  private readonly flowId: string;

  constructor(options: OpenAIWebSocketManagerOptions = {}) {
    super();
    this.wsUrl = options.url ?? OPENAI_WS_URL;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
    this.socketFactory =
      options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.headers = options.headers;
    this.request = options.request;
    this.flowId = randomUUID();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns the previous_response_id from the last completed response,
   * for use in subsequent response.create events.
   */
  get previousResponseId(): string | null {
    return this._previousResponseId;
  }

  get connectionState(): OpenAIWebSocketConnectionState {
    return this._connectionState;
  }

  get lastCloseInfo(): OpenAIWebSocketCloseInfo | null {
    return this._lastCloseInfo;
  }

  /**
   * Opens a WebSocket connection to the OpenAI Responses API.
   * Resolves when the connection is established (open event fires).
   * Rejects if the initial connection fails after max retries.
   */
  connect(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
    this.closed = false;
    this.retryCount = 0;
    this._connectionState = "connecting";
    this._lastCloseInfo = null;
    return this._openConnection();
  }

  /**
   * Sends a typed event to the OpenAI Responses API over the WebSocket.
   * Throws if the connection is not open.
   */
  send(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `OpenAIWebSocketManager: cannot send — connection is not open (readyState=${this.ws?.readyState ?? "no socket"})`,
      );
    }
    const payload = JSON.stringify(event);
    captureWsEvent({
      url: this.wsUrl,
      direction: "outbound",
      kind: "ws-frame",
      flowId: this.flowId,
      payload,
      meta: { eventType: event.type },
    });
    this.ws.send(payload);
  }

  /**
   * Registers a handler for incoming server-sent WebSocket events.
   * Returns an unsubscribe function.
   */
  onMessage(handler: (event: OpenAIWebSocketEvent) => void): () => void {
    this.on("message", handler);
    return () => {
      this.off("message", handler);
    };
  }

  /**
   * Returns true if the WebSocket is currently open and ready to send.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Permanently closes the WebSocket connection and disables auto-reconnect.
   */
  close(): void {
    this.closed = true;
    this._connectionState = "closed";
    this._cancelRetryTimer();
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1000, "Client closed");
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
          // ws can still throw here while the handshake is in-flight.
          this.ws.terminate();
        }
      } catch {
        // Best-effort close during setup/teardown.
      }
      this.ws = null;
    }
  }

  // ─── Internal: Connection Lifecycle ────────────────────────────────────────

  private _openConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.apiKey) {
        reject(new Error("OpenAIWebSocketManager: apiKey is required before connecting."));
        return;
      }

      const requestConfig = resolveProviderRequestPolicyConfig({
        provider: "openai",
        api: "openai-responses",
        baseUrl: this.wsUrl,
        capability: "llm",
        transport: "websocket",
        providerHeaders: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "responses-websocket=v1",
          ...this.headers,
        },
        precedence: "defaults-win",
        request: this.request,
        allowPrivateNetwork: this.request?.allowPrivateNetwork === true,
      });
      const debugAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
      const socket = this.socketFactory(this.wsUrl, {
        headers: requestConfig.headers,
        ...(debugAgent ? { agent: debugAgent } : {}),
        ...buildProviderRequestTlsClientOptions(requestConfig),
      });

      this.ws = socket;

      const onOpen = () => {
        this.retryCount = 0;
        this._connectionState = "open";
        this._lastCloseInfo = null;
        captureWsEvent({
          url: this.wsUrl,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
        });
        resolve();
        this.emit("open");
      };

      const onError = (err: Error) => {
        // Remove open listener so we don't resolve after an error.
        socket.off("open", onOpen);
        // Emit "error" on the manager only when there are listeners; otherwise
        // the promise rejection below is the primary error channel for this
        // initial connection failure. (An uncaught "error" event in Node.js
        // throws synchronously and would prevent the promise from rejecting.)
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
        captureWsEvent({
          url: this.wsUrl,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: err.message,
        });
        if (this._connectionState === "connecting" || this._connectionState === "reconnecting") {
          this._connectionState = "closed";
        }
        reject(err);
      };

      const onClose = (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        const closeInfo = {
          code,
          reason: reasonStr,
          retryable: isRetryableWebSocketClose(code),
        } satisfies OpenAIWebSocketCloseInfo;
        this._lastCloseInfo = closeInfo;
        captureWsEvent({
          url: this.wsUrl,
          direction: "local",
          kind: "ws-close",
          flowId: this.flowId,
          closeCode: code,
          payload: reasonStr,
        });
        this.emit("close", code, reasonStr);

        if (!this.closed && closeInfo.retryable) {
          this._scheduleReconnect();
        } else {
          this._connectionState = "closed";
        }
      };

      const onMessage = (data: WebSocket.RawData) => {
        captureWsEvent({
          url: this.wsUrl,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: Buffer.from(rawDataToString(data)),
        });
        this._handleMessage(data);
      };

      socket.once("open", onOpen);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("message", onMessage);
    });
  }

  private _scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    if (this.retryCount >= this.maxRetries) {
      this._connectionState = "closed";
      this._safeEmitError(
        new Error(`OpenAIWebSocketManager: max reconnect retries (${this.maxRetries}) exceeded.`),
      );
      return;
    }

    const delayMs =
      this.backoffDelaysMs[Math.min(this.retryCount, this.backoffDelaysMs.length - 1)] ?? 1000;
    this.retryCount++;
    this._connectionState = "reconnecting";

    this.retryTimer = setTimeout(() => {
      if (this.closed) {
        return;
      }
      // The onClose handler already calls _scheduleReconnect() for the next
      // attempt, so we intentionally swallow the rejection here to avoid
      // double-scheduling (which would double-increment retryCount per
      // failed reconnect and exhaust the retry budget prematurely).
      this._openConnection().catch(() => {});
    }, delayMs);
  }

  /** Emit an error only if there are listeners; prevents Node.js from crashing
   *  with "unhandled 'error' event" when no one is listening. */
  private _safeEmitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }

  private _cancelRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private _handleMessage(data: WebSocket.RawData): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString("utf8");
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else {
      // Blob or other — coerce to string
      text = String(data);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this._safeEmitError(
        new Error(`OpenAIWebSocketManager: failed to parse message: ${text.slice(0, 200)}`),
      );
      return;
    }

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      this._safeEmitError(
        new Error(
          `OpenAIWebSocketManager: unexpected message shape (no "type" field): ${text.slice(0, 200)}`,
        ),
      );
      return;
    }

    const event = parsed as OpenAIWebSocketEvent;

    // Track previous_response_id on completion
    if (event.type === "response.completed" && event.response?.id) {
      this._previousResponseId = event.response.id;
    }

    this.emit("message", event);
  }

  /**
   * Sends a warm-up event to pre-load the connection and model without generating output.
   * Pass tools/instructions to prime the connection for the upcoming session.
   */
  warmUp(params: {
    model: string;
    tools?: FunctionToolDefinition[];
    instructions?: string;
    metadata?: Record<string, string>;
  }): void {
    const event = buildOpenAIWebSocketWarmUpPayload(params);
    this.send(event);
  }
}
export function getOpenAIWebSocketErrorDetails(event: ErrorEvent): {
  status?: number;
  type?: string;
  code?: string;
  message?: string;
  param?: string;
} {
  return {
    status: typeof event.status === "number" ? event.status : undefined,
    type: event.error?.type,
    code: event.error?.code ?? event.code,
    message: event.error?.message ?? event.message,
    param: event.error?.param ?? event.param,
  };
}

function isRetryableWebSocketClose(code: number): boolean {
  return (
    code === 1001 ||
    code === 1005 ||
    code === 1006 ||
    code === 1011 ||
    code === 1012 ||
    code === 1013
  );
}
