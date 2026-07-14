// Realtime transcription websocket session streams audio to transcription providers.
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { RetrySupervisor } from "../../packages/retry/src/index.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { createDebugProxyWebSocketAgent, resolveDebugProxySettings } from "../proxy-capture/env.js";
import { captureWsEvent } from "../proxy-capture/runtime.js";
import type {
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCallbacks,
} from "./provider-types.js";

// Generic websocket-backed realtime transcription session. Providers supply URL,
// protocol messages, and audio framing while core owns reconnection and queues.
export type RealtimeTranscriptionWebSocketTransport = {
  readonly callbacks: RealtimeTranscriptionSessionCallbacks;
  closeNow(): void;
  failConnect(error: Error): void;
  isOpen(): boolean;
  isReady(): boolean;
  markReady(): void;
  sendBinary(payload: Buffer): boolean;
  sendJson(payload: unknown): boolean;
};

/** Provider-specific hooks for creating a websocket transcription session. */
export type RealtimeTranscriptionWebSocketSessionOptions<Event = unknown> = {
  callbacks: RealtimeTranscriptionSessionCallbacks;
  connectClosedBeforeReadyMessage?: string;
  connectTimeoutMessage?: string;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  maxQueuedBytes?: number;
  maxReconnectAttempts?: number;
  onClose?: (transport: RealtimeTranscriptionWebSocketTransport) => void;
  onMessage?: (event: Event, transport: RealtimeTranscriptionWebSocketTransport) => void;
  onOpen?: (transport: RealtimeTranscriptionWebSocketTransport) => void;
  parseMessage?: (payload: Buffer) => Event;
  providerId: string;
  readyOnOpen?: boolean;
  reconnectDelayMs?: number;
  reconnectLimitMessage?: string;
  sendAudio: (audio: Buffer, transport: RealtimeTranscriptionWebSocketTransport) => void;
  url: string | (() => string | Promise<string>);
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
// A raw WebSocket open is not recovery. Only a provider-ready connection
// that survives this window earns a fresh retry budget.
const RECONNECT_STABLE_RESET_MS = 30_000;
// Bound inbound messages before ws buffers them for JSON parsing. The 16 MiB cap
// matches realtime voice; ws rejects larger messages with close 1009 before
// they reach onMessage, replacing its 100 MiB client default.
export const REALTIME_TRANSCRIPTION_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

function rawWsDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function defaultParseMessage(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString()) as unknown;
  } catch {
    throw new Error("Realtime transcription websocket received malformed JSON.");
  }
}

class WebSocketRealtimeTranscriptionSession<Event> implements RealtimeTranscriptionSession {
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private connected = false;
  private currentUrl = "";
  private queuedAudio: Buffer[] = [];
  private queuedBytes = 0;
  private ready = false;
  private readySinceMs: number | undefined;
  private readonly reconnectSupervisor: RetrySupervisor;
  private reconnecting = false;
  private suppressReconnect = false;
  private ws: WebSocket | null = null;
  private readonly flowId = randomUUID();
  private readonly options: RealtimeTranscriptionWebSocketSessionOptions<Event>;
  private readonly transport: RealtimeTranscriptionWebSocketTransport;
  private failConnect: ((error: Error) => void) | undefined;
  private markReady: (() => void) | undefined;

  constructor(options: RealtimeTranscriptionWebSocketSessionOptions<Event>) {
    this.options = options;
    this.reconnectSupervisor = new RetrySupervisor(
      {
        initialMs: options.reconnectDelayMs ?? 1000,
        maxMs: Number.MAX_SAFE_INTEGER,
        factor: 2,
        jitter: 0,
      },
      options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
    );
    this.transport = {
      callbacks: options.callbacks,
      closeNow: () => {
        this.closed = true;
        this.reconnectSupervisor.cancel();
        this.forceClose();
      },
      failConnect: (error) => this.failConnect?.(error),
      isOpen: () => this.ws?.readyState === WebSocket.OPEN,
      isReady: () => this.ready,
      markReady: () => this.markReady?.(),
      sendBinary: (payload) => this.sendBinary(payload),
      sendJson: (payload) => this.sendJson(payload),
    };
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.suppressReconnect = false;
    this.readySinceMs = undefined;
    this.reconnectSupervisor.reset();
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (this.closed || audio.byteLength === 0) {
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
      this.options.sendAudio(audio, this.transport);
      return;
    }
    // Audio may arrive before provider-specific readiness. Queue bounded bytes
    // instead of dropping early microphone frames during connect/reconnect.
    this.queueAudio(audio);
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.ready = false;
    this.readySinceMs = undefined;
    this.reconnectSupervisor.cancel();
    this.queuedAudio = [];
    this.queuedBytes = 0;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.forceClose();
      return;
    }
    try {
      this.options.onClose?.(this.transport);
    } catch (error) {
      this.emitError(error);
    }
    this.closeTimer = setTimeout(() => this.forceClose(), this.closeTimeoutMs);
  }

  isConnected(): boolean {
    return this.connected && this.ready;
  }

  private get closeTimeoutMs(): number {
    return this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  }
  private get connectTimeoutMs(): number {
    return this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  private get maxQueuedBytes(): number {
    return this.options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ready = false;
      const debugProxy = resolveDebugProxySettings();
      const proxyAgent = createDebugProxyWebSocketAgent(debugProxy);
      let settled = false;
      let opened = false;
      let connectTimeout: ReturnType<typeof setTimeout> | undefined;

      const normalizeError = (error: unknown) =>
        error instanceof Error ? error : new Error(String(error));

      const clearConnectTimeout = () => {
        if (connectTimeout) {
          clearTimeout(connectTimeout);
          connectTimeout = undefined;
        }
      };

      const finishClosedConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearConnectTimeout();
        resolve();
      };

      const finishConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearConnectTimeout();
        this.ready = true;
        this.readySinceMs = Date.now();
        this.flushQueuedAudio();
        resolve();
      };

      const failConnect = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearConnectTimeout();
        this.emitError(error);
        this.suppressReconnect = true;
        this.forceClose();
        reject(error);
      };

      this.markReady = finishConnect;
      this.failConnect = failConnect;

      connectTimeout = setTimeout(() => {
        failConnect(
          new Error(
            this.options.connectTimeoutMessage ??
              `${this.options.providerId} realtime transcription connection timeout`,
          ),
        );
      }, this.connectTimeoutMs);

      void (async () => {
        let connection: { headers?: Record<string, string>; url: string };
        try {
          connection = await this.resolveConnection();
        } catch (error) {
          failConnect(normalizeError(error));
          return;
        }
        if (settled) {
          return;
        }
        if (this.closed) {
          finishClosedConnect();
          return;
        }

        this.currentUrl = connection.url;
        try {
          this.ws = new WebSocket(this.currentUrl, {
            headers: connection.headers,
            maxPayload: REALTIME_TRANSCRIPTION_WS_MAX_PAYLOAD_BYTES,
            ...(proxyAgent ? { agent: proxyAgent } : {}),
          });
        } catch (error) {
          failConnect(normalizeError(error));
          return;
        }

        this.ws.on("open", () => {
          opened = true;
          this.connected = true;
          this.captureLocalOpen();
          try {
            this.options.onOpen?.(this.transport);
            if (this.options.readyOnOpen) {
              finishConnect();
            }
          } catch (error) {
            failConnect(normalizeError(error));
          }
        });

        this.ws.on("message", (data) => {
          const payload = rawWsDataToBuffer(data);
          this.captureFrame("inbound", payload);
          try {
            if (!this.options.onMessage) {
              return;
            }
            const parseMessage = this.options.parseMessage ?? defaultParseMessage;
            this.options.onMessage(parseMessage(payload) as Event, this.transport);
          } catch (error) {
            this.emitError(error);
          }
        });

        this.ws.on("error", (error) => {
          const normalized = normalizeError(error);
          this.captureError(normalized);
          if (!opened || !settled) {
            failConnect(normalized);
            return;
          }
          this.emitError(normalized);
        });

        this.ws.on("close", (code, reasonBuffer) => {
          clearConnectTimeout();
          this.captureClose(code, reasonBuffer);
          const readyForMs = this.readySinceMs === undefined ? 0 : Date.now() - this.readySinceMs;
          this.connected = false;
          this.ready = false;
          this.readySinceMs = undefined;
          if (readyForMs >= RECONNECT_STABLE_RESET_MS) {
            this.reconnectSupervisor.reset();
          }
          if (this.closeTimer) {
            clearTimeout(this.closeTimer);
            this.closeTimer = undefined;
          }
          if (this.closed) {
            return;
          }
          if (this.suppressReconnect) {
            this.suppressReconnect = false;
            return;
          }
          if (!opened || !settled) {
            failConnect(
              new Error(
                this.options.connectClosedBeforeReadyMessage ??
                  `${this.options.providerId} realtime transcription connection closed before ready`,
              ),
            );
            return;
          }
          void this.attemptReconnect();
        });
      })();
    });
  }

  private async resolveConnection(): Promise<{
    headers?: Record<string, string>;
    url: string;
  }> {
    const url = await (typeof this.options.url === "function"
      ? this.options.url()
      : this.options.url);
    const headers = await (typeof this.options.headers === "function"
      ? this.options.headers()
      : this.options.headers);
    return { url, headers };
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed || this.reconnecting) {
      return;
    }
    const retry = this.reconnectSupervisor.next();
    if (!retry) {
      this.emitError(
        new Error(
          this.options.reconnectLimitMessage ??
            `${this.options.providerId} realtime transcription reconnect limit reached`,
        ),
      );
      return;
    }
    this.reconnecting = true;
    try {
      await sleepWithAbort(retry.delayMs, retry.signal);
      if (!this.closed) {
        await this.doConnect();
      }
    } catch {
      if (!this.closed) {
        this.reconnecting = false;
        await this.attemptReconnect();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private queueAudio(audio: Buffer): void {
    this.queuedAudio.push(Buffer.from(audio));
    this.queuedBytes += audio.byteLength;
    while (this.queuedBytes > this.maxQueuedBytes && this.queuedAudio.length > 0) {
      // Keep the most recent audio when reconnects stall; old buffered audio is
      // less useful than avoiding unbounded memory growth.
      const dropped = this.queuedAudio.shift();
      this.queuedBytes -= dropped?.byteLength ?? 0;
    }
  }

  private flushQueuedAudio(): void {
    for (const audio of this.queuedAudio) {
      this.options.sendAudio(audio, this.transport);
    }
    this.queuedAudio = [];
    this.queuedBytes = 0;
  }

  private sendBinary(payload: Buffer): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.captureFrame("outbound", payload);
    this.ws.send(payload);
    return true;
  }

  private sendJson(payload: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(payload);
    this.captureFrame("outbound", serialized);
    this.ws.send(serialized);
    return true;
  }

  private forceClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.connected = false;
    this.ready = false;
    this.readySinceMs = undefined;
    if (this.ws) {
      this.ws.close(1000, "Transcription session closed");
      this.ws = null;
    }
  }

  private emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      this.options.callbacks.onError?.(normalized);
    } catch (callbackError) {
      try {
        this.captureError(
          callbackError instanceof Error ? callbackError : new Error(String(callbackError)),
        );
      } catch {
        // Error observers are diagnostic hooks; capture failures must not
        // replace the original provider/session error.
      }
    }
  }

  private captureFrame(direction: "inbound" | "outbound", payload: Buffer | string): void {
    captureWsEvent({
      url: this.currentUrl,
      direction,
      kind: "ws-frame",
      flowId: this.flowId,
      payload,
      meta: { provider: this.options.providerId, capability: "realtime-transcription" },
    });
  }

  private captureLocalOpen(): void {
    captureWsEvent({
      url: this.currentUrl,
      direction: "local",
      kind: "ws-open",
      flowId: this.flowId,
      meta: { provider: this.options.providerId, capability: "realtime-transcription" },
    });
  }

  private captureError(error: Error): void {
    captureWsEvent({
      url: this.currentUrl,
      direction: "local",
      kind: "error",
      flowId: this.flowId,
      errorText: error.message,
      meta: { provider: this.options.providerId, capability: "realtime-transcription" },
    });
  }

  private captureClose(code: number, reasonBuffer: Buffer): void {
    captureWsEvent({
      url: this.currentUrl,
      direction: "local",
      kind: "ws-close",
      flowId: this.flowId,
      closeCode: code,
      meta: {
        provider: this.options.providerId,
        capability: "realtime-transcription",
        reason: reasonBuffer.length > 0 ? reasonBuffer.toString("utf8") : undefined,
      },
    });
  }
}

/** Creates a reusable websocket session wrapper for a provider implementation. */
export function createRealtimeTranscriptionWebSocketSession<Event = unknown>(
  options: RealtimeTranscriptionWebSocketSessionOptions<Event>,
): RealtimeTranscriptionSession {
  return new WebSocketRealtimeTranscriptionSession(options);
}
