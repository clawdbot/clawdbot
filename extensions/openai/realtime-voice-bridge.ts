import { randomUUID } from "node:crypto";
import { coerceErrorMessage, toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { RealtimeVoiceSessionLifecycle } from "openclaw/plugin-sdk/realtime-voice";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import WebSocket from "ws";
import {
  captureOpenAIRealtimeWsClose,
  readRealtimeErrorDetail,
} from "./realtime-provider-shared.js";
import { buildOpenAIRealtimeSidebandUrl } from "./realtime-quicksilver-wire.js";
import {
  OpenAIRealtimeEvents,
  OpenAIRealtimeMalformedAudioError,
} from "./realtime-voice-events.js";
import {
  OPENAI_REALTIME_DEFAULT_MODEL,
  OPENAI_REALTIME_API_KEY_REQUIRED,
  OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
  OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED,
  OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES,
  OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
  hasOpenAIRealtimeConfiguredApiKeyInput,
  isDirectOpenAIRealtimeWebSocketUrl,
  isOpenAIRealtimeStartupAuthFailure,
  requireOpenAIRealtimeApiKey,
  requireOpenAIRealtimePlatformAuth,
  resolveOpenAIRealtimeEnvApiKey,
  resolveOpenAIRealtimeSecretInput,
  type OpenAIRealtimeUserMessageOptions,
  type OpenAIRealtimeVoiceBridgeConfig,
  type RealtimeEvent,
} from "./realtime-voice-session-policy.js";

const OPENAI_REALTIME_MAX_BUFFERED_AUDIO_BYTES = 1024 * 1024;
const OPENAI_REALTIME_AUDIO_DROP_WARN_INTERVAL_MS = 5_000;

export class OpenAIRealtimeBridge extends OpenAIRealtimeEvents implements RealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = OPENAI_REALTIME_DEFAULT_MODEL;

  private static readonly MAX_RECONNECT_ATTEMPTS = 5;

  private static readonly BASE_RECONNECT_DELAY_MS = 1000;

  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  private ws: WebSocket | null = null;

  private readonly lifecycle: RealtimeVoiceSessionLifecycle;

  private connectionUrl = "";

  private readonly flowId = randomUUID();

  private sessionReadyFired = false;

  private reconnectReason: string | undefined;

  private activeConnectionReason: string | undefined;

  private terminalError: Error | undefined;

  private droppedInputAudioFrames = 0;

  private lastInputAudioDropWarningAt = Number.NEGATIVE_INFINITY;

  constructor(config: OpenAIRealtimeVoiceBridgeConfig) {
    super(config);
    this.lifecycle = new RealtimeVoiceSessionLifecycle("OpenAI", {
      pendingAudioOverflowPolicy: "drop-oldest",
      onPendingAudioOverflow: () =>
        this.config.logger.warn("OpenAI realtime input audio queue overflow; keeping newest audio"),
    });
  }

  async connect(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    await this.lifecycle.connect((connection) => this.doConnect(connection));
  }

  sendAudio(audio: Buffer): void {
    if (this.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.lifecycle.isReady() || this.ws?.readyState !== WebSocket.OPEN) {
      this.lifecycle.enqueuePendingAudio(audio);
      return;
    }
    if (this.ws.bufferedAmount > OPENAI_REALTIME_MAX_BUFFERED_AUDIO_BYTES) {
      this.droppedInputAudioFrames += 1;
      const now = Date.now();
      if (now - this.lastInputAudioDropWarningAt >= OPENAI_REALTIME_AUDIO_DROP_WARN_INTERVAL_MS) {
        this.config.logger.warn(
          `OpenAI realtime input audio backpressure; droppedFrames=${this.droppedInputAudioFrames}`,
        );
        this.droppedInputAudioFrames = 0;
        this.lastInputAudioDropWarningAt = now;
      }
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  sendUserMessage(text: string, options?: OpenAIRealtimeUserMessageOptions): void {
    if (
      options?.toolChoice &&
      (this.responseActive ||
        this.responseCreateInFlight ||
        this.responseCancelInFlight ||
        this.pendingToolCallIds.size > 0)
    ) {
      throw new Error("Forced realtime tool choice requires an idle response state");
    }
    if (this.pendingToolCallIds.size > 0) {
      // Control/status speech must not wait behind the long-running consult whose
      // function output owns the default conversation response.
      this.standaloneSpeechQueue.push(text);
      this.flushStandaloneSpeech();
      return;
    }
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponseCreate(options);
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected() || !this.ws) {
      return;
    }
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the meeting.");
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (this.lifecycle.phase() === "terminal" || !this.pendingToolCallIds.has(callId)) {
      return;
    }
    const output = JSON.stringify(result);
    if (typeof output !== "string") {
      throw new Error("OpenAI realtime voice tool result is not JSON-serializable");
    }
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    if (options?.willContinue === true) {
      this.continuingToolCallIds.add(callId);
      return;
    }
    this.continuingToolCallIds.delete(callId);
    this.pendingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      this.flushPendingResponseCreate();
      return;
    }
    this.requestResponseCreate();
  }

  close(): void {
    const connection = this.lifecycle.currentConnection();
    if (!this.lifecycle.cancel()) {
      return;
    }
    this.resetTerminalState();
    if (!connection) {
      return;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "Bridge closed");
    this.notifyClose(connection, "completed");
  }

  isConnected(): boolean {
    return this.lifecycle.isReady() && this.ws?.readyState === WebSocket.OPEN;
  }

  private async doConnect(lifecycleConnection: RealtimeVoiceSessionConnection): Promise<void> {
    let activeWs: WebSocket | undefined;
    let startupFrameBytes = 0;
    const attempt = this.lifecycle.createConnectAttempt({
      connection: lifecycleConnection,
      timeoutMs: OpenAIRealtimeBridge.CONNECT_TIMEOUT_MS,
      timeoutError: () => new Error("OpenAI realtime connection timeout"),
      onTimeout: () => activeWs?.terminate(),
      onAbort: () => {
        if (activeWs && activeWs.readyState !== WebSocket.CLOSED) {
          activeWs.close(1000, "connection canceled");
        }
      },
    });

    const openWebSocket = (resolvedConnection: {
      url: string;
      headers: Record<string, string>;
    }) => {
      if (attempt.settled) {
        return;
      }
      if (!this.lifecycle.isCurrent(lifecycleConnection) || lifecycleConnection.signal.aborted) {
        attempt.resolve();
        return;
      }
      // Auth preparation owns its own timeout. Start the socket deadline only
      // after connection parameters are available.
      attempt.startTimeout();
      const url = resolvedConnection.url;
      this.connectionUrl = resolvedConnection.url;
      const debugProxy = resolveDebugProxySettings();
      const proxyAgent = createDebugProxyWebSocketAgent(debugProxy);
      const ws = new WebSocket(resolvedConnection.url, {
        headers: resolvedConnection.headers,
        maxPayload: OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      activeWs = ws;
      this.ws = ws;

      const rejectStartup = (error: Error) => {
        if (!attempt.rejectStartup(error)) {
          return;
        }
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close(1000, "startup failed");
        }
      };

      ws.on("open", () => {
        if (!this.lifecycle.acceptsEvents(lifecycleConnection)) {
          ws.close(1000, "stale connection");
          return;
        }
        this.resetRealtimeSessionState();
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
          meta: {
            provider: "openai",
            capability: "realtime-voice",
          },
        });
        this.sendSessionUpdate();
      });

      ws.on("message", (data: Buffer) => {
        if (!this.lifecycle.acceptsEvents(lifecycleConnection) || this.ws !== ws) {
          return;
        }
        if (attempt.settled && !attempt.ready) {
          return;
        }
        if (!attempt.ready) {
          startupFrameBytes += data.byteLength;
          if (startupFrameBytes > OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES) {
            const error = new Error("OpenAI realtime sideband startup buffer exceeded");
            attempt.reject(error);
            this.failConnection(error, ws, lifecycleConnection, {
              code: 1009,
              reason: "Sideband startup buffer exceeded",
            });
            return;
          }
        }
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: data,
          meta: {
            provider: "openai",
            capability: "realtime-voice",
          },
        });
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          if (event.type === "error" && !attempt.ready) {
            // Only direct OpenAI auth failures get bounded remediation. Azure,
            // custom endpoints, and non-auth startup details remain provider-owned.
            rejectStartup(
              isDirectOpenAIRealtimeWebSocketUrl(url) &&
                isOpenAIRealtimeStartupAuthFailure(event.error)
                ? new Error(OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED)
                : new Error(readRealtimeErrorDetail(event.error)),
            );
            return;
          }
          if (event.type === "session.updated") {
            try {
              this.handleEvent(event, lifecycleConnection);
            } catch (error) {
              const readyError = toStringifiedError(error);
              attempt.reject(readyError);
              this.failConnection(readyError, ws, lifecycleConnection, {
                code: 1011,
                reason: "Readiness callback failed",
              });
              return;
            }
            attempt.resolve(this.lifecycle.isReady());
            return;
          }
          this.handleEvent(event, lifecycleConnection);
        } catch (error) {
          if (error instanceof OpenAIRealtimeMalformedAudioError) {
            attempt.reject(error);
            this.failConnection(error, ws, lifecycleConnection, {
              code: 1002,
              reason: "Malformed audio payload",
            });
            return;
          }
          console.error("[openai] realtime event parse failed:", error);
        }
      });

      ws.on("error", (error) => {
        if (!this.lifecycle.acceptsEvents(lifecycleConnection) || this.ws !== ws) {
          return;
        }
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: coerceErrorMessage(error),
          meta: {
            provider: "openai",
            capability: "realtime-voice",
          },
        });
        if (!attempt.ready) {
          const startupError = toStringifiedError(error);
          rejectStartup(
            isDirectOpenAIRealtimeWebSocketUrl(url) &&
              isOpenAIRealtimeStartupAuthFailure(startupError)
              ? new Error(OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED)
              : startupError,
          );
          return;
        }
        this.config.onError?.(toStringifiedError(error));
      });

      ws.on("close", (code, reasonBuffer) => {
        captureOpenAIRealtimeWsClose({
          url,
          flowId: this.flowId,
          capability: "realtime-voice",
          code,
          reasonBuffer,
        });
        if (!this.lifecycle.isCurrent(lifecycleConnection)) {
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        if (attempt.startupFailed) {
          return;
        }
        if (this.terminalError) {
          this.notifyClose(lifecycleConnection, "error");
          return;
        }
        if (this.lifecycle.terminalOutcome(lifecycleConnection) === "completed") {
          attempt.resolve();
          this.notifyClose(lifecycleConnection, "completed");
          return;
        }
        if (!attempt.ready && !attempt.settled) {
          const error = new Error("OpenAI realtime connection closed before ready");
          attempt.reject(error);
          return;
        }
        const reason = this.reconnectReason ?? "websocket-close";
        this.reconnectReason = undefined;
        void this.attemptReconnect(reason, lifecycleConnection);
      });
    };

    let connectionOrPromise:
      | { url: string; headers: Record<string, string> }
      | Promise<{ url: string; headers: Record<string, string> }>;
    try {
      connectionOrPromise = this.resolveConnectionParams();
    } catch (error) {
      attempt.reject(toStringifiedError(error));
      return attempt.promise;
    }
    if (connectionOrPromise instanceof Promise) {
      void connectionOrPromise.then(openWebSocket).catch((error: unknown) => {
        if (
          !this.lifecycle.isCurrent(lifecycleConnection) ||
          this.lifecycle.terminalOutcome(lifecycleConnection) === "completed"
        ) {
          attempt.resolve();
          return;
        }
        attempt.reject(toStringifiedError(error));
      });
    } else {
      try {
        openWebSocket(connectionOrPromise);
      } catch (error) {
        attempt.reject(toStringifiedError(error));
      }
    }
    await attempt.promise;
  }

  private resolveConnectionParams():
    | { url: string; headers: Record<string, string> }
    | Promise<{ url: string; headers: Record<string, string> }> {
    const cfg = this.config;
    const model = cfg.model ?? OpenAIRealtimeBridge.DEFAULT_MODEL;
    if (cfg.azureEndpoint && cfg.azureDeployment) {
      const apiKey = requireOpenAIRealtimeApiKey(cfg.apiKey);
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      const apiVersion = cfg.azureApiVersion ?? "2024-10-01-preview";
      const url = `${base}/openai/realtime?api-version=${apiVersion}&deployment=${encodeURIComponent(
        cfg.azureDeployment,
      )}`;
      return {
        url,
        headers: resolveProviderRequestHeaders({
          provider: "openai",
          baseUrl: url,
          capability: "audio",
          transport: "websocket",
          defaultHeaders: { "api-key": apiKey },
        }) ?? { "api-key": apiKey },
      };
    }

    if (hasOpenAIRealtimeConfiguredApiKeyInput(cfg.apiKey)) {
      const directApiKey = resolveOpenAIRealtimeSecretInput(cfg.apiKey);
      if (directApiKey.status === "missing") {
        throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
      }
      return this.resolveApiKeyConnectionParams(directApiKey.value, model);
    }

    if (cfg.azureEndpoint) {
      const directApiKey = resolveOpenAIRealtimeEnvApiKey();
      if (directApiKey.status === "missing") {
        throw new Error(OPENAI_REALTIME_API_KEY_REQUIRED);
      }
      return this.resolveApiKeyConnectionParams(directApiKey.value, model);
    }

    return this.resolveDefaultConnectionParams(model);
  }

  private async resolveDefaultConnectionParams(model: string): Promise<{
    url: string;
    headers: Record<string, string>;
  }> {
    const auth = await requireOpenAIRealtimePlatformAuth({
      configuredApiKey: this.config.apiKey,
      cfg: this.config.cfg,
      agentId: this.config.agentId,
    });
    return this.resolveApiKeyConnectionParams(auth.value, model);
  }

  private resolveApiKeyConnectionParams(
    apiKey: string,
    model: string,
  ): { url: string; headers: Record<string, string> } {
    const cfg = this.config;
    if (cfg.azureEndpoint) {
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      const url = `${base}/v1/realtime?model=${encodeURIComponent(model)}`;
      return {
        url,
        headers: resolveProviderRequestHeaders({
          provider: "openai",
          baseUrl: url,
          capability: "audio",
          transport: "websocket",
          defaultHeaders: { Authorization: `Bearer ${apiKey}` },
        }) ?? { Authorization: `Bearer ${apiKey}` },
      };
    }

    const url = cfg.callId
      ? buildOpenAIRealtimeSidebandUrl(cfg.callId)
      : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    return {
      url,
      headers: resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: url,
        capability: "audio",
        transport: "websocket",
        defaultHeaders: {
          Authorization: `Bearer ${apiKey}`,
        },
      }) ?? {
        Authorization: `Bearer ${apiKey}`,
      },
    };
  }

  private async attemptReconnect(
    reason: string,
    connection: RealtimeVoiceSessionConnection,
  ): Promise<void> {
    const retry = this.lifecycle.retry(connection, OpenAIRealtimeBridge.MAX_RECONNECT_ATTEMPTS);
    if (!retry) {
      return;
    }
    if (retry === "exhausted") {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${OpenAIRealtimeBridge.MAX_RECONNECT_ATTEMPTS}`,
      });
      if (this.lifecycle.failure(connection)) {
        this.resetTerminalState();
      }
      this.notifyClose(connection, "error");
      return;
    }
    const attempt = retry.attempt;
    const delay = OpenAIRealtimeBridge.BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
    if (attempt === 1) {
      // OpenAI reconnects start a fresh provider generation. Reset consumers
      // before backoff so stale async work cannot satisfy reused call ids.
      this.resetRealtimeSessionState();
      this.config.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
    }
    this.config.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    try {
      await sleepWithAbort(delay, retry.signal);
    } catch (error) {
      if (!retry.signal.aborted) {
        throw error;
      }
      return;
    }
    const nextConnection = this.lifecycle.reconnect(connection);
    if (!nextConnection) {
      return;
    }
    try {
      await this.doConnect(nextConnection);
      if (!this.lifecycle.isCurrent(nextConnection) || !this.lifecycle.isReady()) {
        return;
      }
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      if (!this.lifecycle.acceptsEvents(nextConnection)) {
        return;
      }
      this.config.onError?.(toStringifiedError(error));
      await this.attemptReconnect(reason, nextConnection);
    }
  }

  private markSessionReady(connection: RealtimeVoiceSessionConnection): void {
    if (!this.lifecycle.ready(connection)) {
      return;
    }
    if (this.activeConnectionReason) {
      this.config.onEvent?.({
        direction: "server",
        type: "session.rotation.ready",
        detail: `reason=${this.activeConnectionReason}`,
      });
      this.activeConnectionReason = undefined;
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
    for (const chunk of this.lifecycle.drainPendingAudio()) {
      this.sendAudio(chunk);
    }
  }

  private resetTerminalState(): void {
    // Transport retries preserve readiness and rotation attribution. A terminal
    // session clears both so explicit bridge reuse starts as a new session.
    this.sessionReadyFired = false;
    this.reconnectReason = undefined;
    this.activeConnectionReason = undefined;
    this.resetRealtimeSessionState();
  }

  private failConnection(
    error: Error,
    ws: WebSocket,
    connection: RealtimeVoiceSessionConnection,
    close: { code: number; reason: string },
  ): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.lifecycle.failure(connection);
    this.resetTerminalState();
    try {
      this.config.onError?.(error);
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close(close.code, close.reason);
      } else {
        this.notifyClose(connection, "error");
      }
    }
  }

  private notifyClose(
    connection: RealtimeVoiceSessionConnection,
    outcome: "completed" | "error",
  ): void {
    const terminalOutcome = this.lifecycle.close(connection, outcome);
    if (!terminalOutcome) {
      return;
    }
    this.resetTerminalState();
    this.config.onClose?.(terminalOutcome);
  }

  protected sendEvent(event: unknown, detail?: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const type =
        event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
          ? (event as { type: string }).type
          : "unknown";
      this.config.onEvent?.({ direction: "client", type, ...(detail ? { detail } : {}) });
      const payload = JSON.stringify(event);
      captureWsEvent({
        url: this.connectionUrl,
        direction: "outbound",
        kind: "ws-frame",
        flowId: this.flowId,
        payload,
        meta: {
          provider: "openai",
          capability: "realtime-voice",
        },
      });
      this.ws.send(payload);
    }
  }

  protected acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean {
    return this.lifecycle.acceptsEvents(connection);
  }

  protected isTransportOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  protected onSessionUpdated(connection: RealtimeVoiceSessionConnection): void {
    this.markSessionReady(connection);
  }

  protected rotateExpiredSession(): void {
    this.reconnectReason = "max-duration";
    this.activeConnectionReason = "max-duration";
    this.config.onEvent?.({
      direction: "server",
      type: "session.rotation",
      detail: "reason=max-duration",
    });
    this.ws?.close(1000, "max-duration rotation");
  }

  protected failToolCallSessionLimit(
    error: Error,
    connection: RealtimeVoiceSessionConnection,
  ): void {
    const ws = this.ws;
    if (ws) {
      this.failConnection(error, ws, connection, {
        code: 1008,
        reason: "Tool-call session limit exceeded",
      });
    }
  }
}
