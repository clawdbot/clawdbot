import { randomUUID } from "node:crypto";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import WebSocket from "ws";
import {
  XAI_REALTIME_BASE_RECONNECT_DELAY_MS,
  XAI_REALTIME_CONNECT_TIMEOUT_MS,
  XAI_REALTIME_DEFAULT_MODEL,
  XAI_REALTIME_MAX_PENDING_TOOL_RESULTS,
  XAI_REALTIME_MAX_PENDING_USER_MESSAGES,
  XAI_REALTIME_MAX_RECONNECT_ATTEMPTS,
  XAI_REALTIME_WS_MAX_PAYLOAD_BYTES,
  readXaiRealtimeErrorDetail,
  resolveXaiRealtimeApiKey,
  toXaiRealtimeWsUrl,
  type XaiRealtimeEvent,
} from "./realtime-voice-config.js";
import { XaiRealtimeMalformedAudioError, XaiRealtimeVoiceEvents } from "./realtime-voice-events.js";
import {
  XaiRealtimeVoiceLifecycle,
  type XaiRealtimeVoiceConnection,
} from "./realtime-voice-lifecycle.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

export class XaiRealtimeVoiceBridge extends XaiRealtimeVoiceEvents implements RealtimeVoiceBridge {
  private static readonly MAX_PENDING_AUDIO_CHUNKS = 320;
  private static readonly MAX_PENDING_AUDIO_BYTES = 1024 * 1024;
  readonly supportsToolResultContinuation = false;

  private ws: WebSocket | null = null;
  private terminalError: Error | null = null;
  private readonly lifecycle = new XaiRealtimeVoiceLifecycle();
  private connection: XaiRealtimeVoiceConnection | undefined;
  private connectPromise: Promise<void> | undefined;
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private pendingToolResults: Array<{
    callId: string;
    result: unknown;
    options?: RealtimeVoiceToolResultOptions;
  }> = [];
  private pendingUserMessages: string[] = [];
  private connectionUrl = "";
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;

  async connect(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.lifecycle.isReady()) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const connection = this.lifecycle.connect();
    this.connection = connection;
    const connectPromise = this.doConnect(connection);
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    }
  }

  sendAudio(audio: Buffer): void {
    if (this.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.isConnected()) {
      this.enqueuePendingAudio(audio);
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage(text: string): void {
    if (this.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.canSubmitInput()) {
      if (this.pendingUserMessages.length < XAI_REALTIME_MAX_PENDING_USER_MESSAGES) {
        this.pendingUserMessages.push(text);
      } else {
        this.config.onError?.(
          new Error("xAI realtime voice pending user message queue overflow during reconnect"),
        );
      }
      return;
    }
    this.sendUserMessageNow(text);
  }

  triggerGreeting(instructions?: string): void {
    if (this.isConnected() && this.ws) {
      this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the user.");
    }
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (this.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.canSubmitInput()) {
      if (this.pendingToolResults.length < XAI_REALTIME_MAX_PENDING_TOOL_RESULTS) {
        this.pendingToolResults.push({ callId, result, ...(options ? { options } : {}) });
      } else {
        this.config.onError?.(
          new Error("xAI realtime voice pending tool result queue overflow during reconnect"),
        );
      }
      return;
    }
    this.submitToolResultNow(callId, result, options);
  }

  close(): void {
    const connection = this.connection;
    if (!this.lifecycle.cancel()) {
      return;
    }
    this.connectPromise = undefined;
    this.resetTerminalState();
    if (!connection) {
      return;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState !== WebSocket.CLOSED) {
      ws?.close(1000, "Bridge closed");
    }
    this.notifyClose(connection, "completed");
  }

  isConnected(): boolean {
    return this.lifecycle.isReady() && this.ws?.readyState === WebSocket.OPEN;
  }

  private async doConnect(connection: XaiRealtimeVoiceConnection): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let reachedReady = false;
      let startupFailureClosing = false;
      let activeWs: WebSocket | undefined;
      let removeAbortListener = () => {};
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (connectTimeout) {
          clearTimeout(connectTimeout);
        }
        removeAbortListener();
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (connectTimeout) {
          clearTimeout(connectTimeout);
        }
        removeAbortListener();
        reject(error);
      };
      const connectTimeout = setTimeout(() => {
        if (
          this.lifecycle.isCurrent(connection) &&
          !reachedReady &&
          this.lifecycle.terminalOutcome(connection) !== "completed"
        ) {
          startupFailureClosing = true;
          activeWs?.terminate();
          settleReject(new Error("xAI realtime voice connection timeout"));
        }
      }, XAI_REALTIME_CONNECT_TIMEOUT_MS);
      const onAbort = () => {
        const terminalOutcome = this.lifecycle.terminalOutcome(connection);
        if (terminalOutcome !== "error" && activeWs && activeWs.readyState !== WebSocket.CLOSED) {
          activeWs.close(1000, "connection canceled");
        }
        if (terminalOutcome === "completed") {
          settleResolve();
          return;
        }
        const reason = connection.signal.reason;
        settleReject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      connection.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => connection.signal.removeEventListener("abort", onAbort);
      if (connection.signal.aborted) {
        onAbort();
      }

      const openWebSocket = (resolvedConnection: {
        url: string;
        headers: Record<string, string>;
      }) => {
        if (settled) {
          return;
        }
        if (!this.lifecycle.isCurrent(connection) || connection.signal.aborted) {
          settleResolve();
          return;
        }
        const { url, headers } = resolvedConnection;
        this.connectionUrl = url;
        const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
        const ws = new WebSocket(url, {
          headers,
          maxPayload: XAI_REALTIME_WS_MAX_PAYLOAD_BYTES,
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        });
        activeWs = ws;
        this.ws = ws;

        const rejectStartup = (error: Error) => {
          if (!this.lifecycle.acceptsEvents(connection) || reachedReady) {
            return;
          }
          startupFailureClosing = true;
          settleReject(error);
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.close(1000, "startup failed");
          }
        };

        ws.on("open", () => {
          if (!this.lifecycle.acceptsEvents(connection)) {
            ws.close(1000, "stale connection");
            return;
          }
          // Resumed sessions replay prior items, so preserve unresolved tool calls until
          // their outputs are accepted on the replacement socket.
          this.resetRealtimeSessionState({
            preserveToolCallState:
              this.config.sessionResumption === true && this.conversationId !== null,
          });
          captureWsEvent({
            url,
            direction: "local",
            kind: "ws-open",
            flowId: this.flowId,
            meta: { provider: "xai", capability: "realtime-voice" },
          });
          this.sendEvent(this.buildSessionUpdate());
        });

        ws.on("message", (data: Buffer) => {
          if (!this.lifecycle.acceptsEvents(connection) || this.ws !== ws) {
            return;
          }
          if (settled && !reachedReady) {
            return;
          }
          captureWsEvent({
            url,
            direction: "inbound",
            kind: "ws-frame",
            flowId: this.flowId,
            payload: data,
            meta: { provider: "xai", capability: "realtime-voice" },
          });
          try {
            const event = JSON.parse(data.toString()) as XaiRealtimeEvent;
            if (event.type === "error" && !reachedReady) {
              rejectStartup(new Error(readXaiRealtimeErrorDetail(event.error)));
              return;
            }
            this.handleEvent(event, connection);
            if (
              event.type === "session.updated" &&
              this.lifecycle.isCurrent(connection) &&
              this.lifecycle.isReady()
            ) {
              reachedReady = true;
              settleResolve();
            }
          } catch (error) {
            if (error instanceof XaiRealtimeMalformedAudioError) {
              settleReject(error);
              this.failConnection(error, ws, connection);
              return;
            }
            console.error("[xai] realtime event parse failed:", error);
          }
        });

        ws.on("error", (error) => {
          if (!this.lifecycle.acceptsEvents(connection) || this.ws !== ws) {
            return;
          }
          captureWsEvent({
            url,
            direction: "local",
            kind: "error",
            flowId: this.flowId,
            errorText: error instanceof Error ? error.message : String(error),
            meta: { provider: "xai", capability: "realtime-voice" },
          });
          if (!reachedReady) {
            rejectStartup(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        });

        ws.on("close", (code, reasonBuffer) => {
          captureWsEvent({
            url,
            direction: "local",
            kind: "ws-close",
            flowId: this.flowId,
            closeCode: typeof code === "number" ? code : undefined,
            meta: {
              provider: "xai",
              capability: "realtime-voice",
              reason:
                Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
                  ? reasonBuffer.toString("utf8")
                  : undefined,
            },
          });
          if (!this.lifecycle.isCurrent(connection)) {
            return;
          }
          if (this.ws === ws) {
            this.ws = null;
          }
          if (startupFailureClosing) {
            return;
          }
          if (this.terminalError) {
            this.notifyClose(connection, "error");
            return;
          }
          if (this.lifecycle.terminalOutcome(connection) === "completed") {
            settleResolve();
            this.notifyClose(connection, "completed");
            return;
          }
          if (!reachedReady && !settled) {
            settleReject(new Error("xAI realtime voice connection closed before ready"));
            return;
          }
          void this.attemptReconnect("websocket-close", connection);
        });
      };

      void this.resolveConnectionParams()
        .then(openWebSocket)
        .catch((error: unknown) => {
          if (
            !this.lifecycle.isCurrent(connection) ||
            this.lifecycle.terminalOutcome(connection) === "completed"
          ) {
            settleResolve();
            return;
          }
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async resolveConnectionParams(): Promise<{
    url: string;
    headers: Record<string, string>;
  }> {
    const apiKey = this.config.resolveApiKey
      ? await this.config.resolveApiKey()
      : await resolveXaiRealtimeApiKey(this.config.apiKey, this.config.cfg);
    const model = this.config.model ?? XAI_REALTIME_DEFAULT_MODEL;
    const url = toXaiRealtimeWsUrl(
      this.config.baseUrl,
      model,
      this.config.sessionResumption === true ? (this.conversationId ?? undefined) : undefined,
    );
    return {
      url,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...xaiUserAgentHeaderFor(this.config.baseUrl),
      },
    };
  }

  private async attemptReconnect(
    reason: string,
    connection: XaiRealtimeVoiceConnection,
  ): Promise<void> {
    const blocked = this.reconnectBlockReason();
    if (blocked) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=${reason} ${blocked}`,
      });
      this.enterTerminalState(connection);
      return;
    }
    const retry = this.lifecycle.retry(connection, XAI_REALTIME_MAX_RECONNECT_ATTEMPTS);
    if (!retry) {
      return;
    }
    if (retry === "exhausted") {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${XAI_REALTIME_MAX_RECONNECT_ATTEMPTS}`,
      });
      this.enterTerminalState(connection);
      return;
    }
    const attempt = retry.attempt;
    const delay = XAI_REALTIME_BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
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
    this.connection = nextConnection;
    try {
      await this.doConnect(nextConnection);
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      if (
        this.terminalError ||
        !this.lifecycle.isCurrent(nextConnection) ||
        this.lifecycle.terminalOutcome(nextConnection)
      ) {
        return;
      }
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason, nextConnection);
    }
  }

  private reconnectBlockReason(): string | undefined {
    if (this.config.sessionResumption !== true) {
      return "sessionResumption=false";
    }
    if (this.pendingToolResultAcks.size > 0) {
      // xAI has no replay-complete event, so retrying an unacknowledged output
      // could duplicate a side effect at the recovery boundary.
      return `unacknowledgedToolResults=${this.pendingToolResultAcks.size}`;
    }
    if (!this.conversationId) {
      return "missingConversationId=true";
    }
    return undefined;
  }

  protected acceptsEvent(connection: XaiRealtimeVoiceConnection): boolean {
    return this.lifecycle.acceptsEvents(connection);
  }

  protected onSessionUpdated(connection: XaiRealtimeVoiceConnection): void {
    if (!this.lifecycle.ready(connection)) {
      return;
    }
    const pendingAudio = this.pendingAudio.splice(0);
    this.pendingAudioBytes = 0;
    for (const chunk of pendingAudio) {
      this.sendAudio(chunk);
    }
    for (const pending of this.pendingToolResults.splice(0)) {
      this.submitToolResultNow(pending.callId, pending.result, pending.options);
    }
    for (const message of this.pendingUserMessages.splice(0)) {
      this.sendUserMessageNow(message);
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
  }

  protected sendEvent(event: unknown, detail?: string): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }
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
      meta: { provider: "xai", capability: "realtime-voice" },
    });
    ws.send(payload);
  }

  private canSubmitInput(): boolean {
    return this.isConnected();
  }

  private enqueuePendingAudio(audio: Buffer): void {
    if (
      this.pendingAudio.length >= XaiRealtimeVoiceBridge.MAX_PENDING_AUDIO_CHUNKS ||
      this.pendingAudioBytes + audio.byteLength > XaiRealtimeVoiceBridge.MAX_PENDING_AUDIO_BYTES
    ) {
      return;
    }
    const queuedAudio = Buffer.from(audio);
    this.pendingAudio.push(queuedAudio);
    this.pendingAudioBytes += queuedAudio.byteLength;
  }

  private failConnection(
    error: XaiRealtimeMalformedAudioError,
    ws: WebSocket,
    connection: XaiRealtimeVoiceConnection,
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
        ws.close(1002, "Malformed audio payload");
      } else {
        this.notifyClose(connection, "error");
      }
    }
  }

  private enterTerminalState(connection: XaiRealtimeVoiceConnection): void {
    if (this.lifecycle.failure(connection)) {
      this.resetTerminalState();
    }
    this.notifyClose(connection, "error");
  }

  private notifyClose(
    connection: XaiRealtimeVoiceConnection,
    outcome: "completed" | "error",
  ): void {
    const terminalOutcome = this.lifecycle.close(connection, outcome);
    if (!terminalOutcome) {
      return;
    }
    this.resetTerminalState();
    this.config.onClose?.(terminalOutcome);
  }

  private resetTerminalState(): void {
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingToolResults = [];
    this.pendingUserMessages = [];
    this.conversationId = null;
    this.resetRealtimeSessionState();
  }
}
