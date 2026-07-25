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
import { XaiRealtimeVoiceEvents } from "./realtime-voice-events.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

export class XaiRealtimeVoiceBridge extends XaiRealtimeVoiceEvents implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = false;

  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private pendingToolResults: Array<{
    callId: string;
    result: unknown;
    options?: RealtimeVoiceToolResultOptions;
  }> = [];
  private pendingUserMessages: string[] = [];
  private connectionUrl = "";
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;
  private reconnectAbortController = new AbortController();

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    if (this.reconnectAbortController.signal.aborted) {
      this.reconnectAbortController = new AbortController();
    }
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pendingAudio.length < 320) {
        this.pendingAudio.push(audio);
      }
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
    if (!this.canSubmitToolResult()) {
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
    this.intentionallyClosed = true;
    // The bridge owns both its active socket and reconnect delay; canceling
    // both keeps terminal close from retaining callbacks for the full backoff.
    this.reconnectAbortController.abort();
    this.connected = false;
    this.sessionConfigured = false;
    this.pendingToolResultAcks.clear();
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private async doConnect(): Promise<void> {
    const apiKey = this.config.resolveApiKey
      ? await this.config.resolveApiKey()
      : await resolveXaiRealtimeApiKey(this.config.apiKey, this.config.cfg);
    const model = this.config.model ?? XAI_REALTIME_DEFAULT_MODEL;
    const url = toXaiRealtimeWsUrl(
      this.config.baseUrl,
      model,
      this.config.sessionResumption === true ? (this.conversationId ?? undefined) : undefined,
    );
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      ...xaiUserAgentHeaderFor(this.config.baseUrl),
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let startupFailureClosing = false;
      const settleResolve = () => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimeout);
          resolve();
        }
      };
      const settleReject = (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimeout);
          reject(error);
        }
      };
      const connectTimeout = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          startupFailureClosing = true;
          this.ws?.terminate();
          settleReject(new Error("xAI realtime voice connection timeout"));
        }
      }, XAI_REALTIME_CONNECT_TIMEOUT_MS);

      if (this.intentionallyClosed) {
        settleResolve();
        return;
      }

      this.connectionUrl = url;
      const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
      const ws = new WebSocket(url, {
        headers,
        maxPayload: XAI_REALTIME_WS_MAX_PAYLOAD_BYTES,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      this.ws = ws;

      const rejectStartup = (error: Error) => {
        startupFailureClosing = true;
        settleReject(error);
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close(1000, "startup failed");
        }
      };

      ws.on("open", () => {
        // Resumed sessions replay prior items, so preserve unresolved tool calls until
        // their outputs are accepted on the replacement socket.
        this.resetRealtimeSessionState({
          preserveToolCallState:
            this.config.sessionResumption === true && this.conversationId !== null,
        });
        this.connected = true;
        this.sessionConfigured = false;
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
        if (settled && !this.sessionConfigured) {
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
          if (event.type === "error" && !this.sessionConfigured) {
            rejectStartup(new Error(readXaiRealtimeErrorDetail(event.error)));
            return;
          }
          this.handleEvent(event);
          if (event.type === "session.updated") {
            settleResolve();
          }
        } catch (error) {
          console.error("[xai] realtime event parse failed:", error);
        }
      });

      ws.on("error", (error) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: error instanceof Error ? error.message : String(error),
          meta: { provider: "xai", capability: "realtime-voice" },
        });
        if (!this.sessionConfigured) {
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
        if (startupFailureClosing) {
          if (this.ws === ws) {
            this.connected = false;
            this.sessionConfigured = false;
          }
          return;
        }
        const wasSessionConfigured = this.sessionConfigured;
        this.connected = false;
        this.sessionConfigured = false;
        if (this.intentionallyClosed) {
          settleResolve();
          this.config.onClose?.("completed");
          return;
        }
        if (!wasSessionConfigured && !settled) {
          settleReject(new Error("xAI realtime voice connection closed before ready"));
          return;
        }
        void this.attemptReconnect("websocket-close");
      });
    });
  }

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    const blocked = this.reconnectBlockReason();
    if (blocked) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=${reason} ${blocked}`,
      });
      this.config.onClose?.("error");
      return;
    }
    if (this.reconnectAttempts >= XAI_REALTIME_MAX_RECONNECT_ATTEMPTS) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${this.reconnectAttempts}`,
      });
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = XAI_REALTIME_BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
    this.config.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    const reconnectSignal = this.reconnectAbortController.signal;
    try {
      await sleepWithAbort(delay, reconnectSignal);
    } catch (error) {
      if (!reconnectSignal.aborted) {
        throw error;
      }
      return;
    }
    if (this.intentionallyClosed) {
      return;
    }
    try {
      await this.doConnect();
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason);
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

  protected onSessionUpdated(): void {
    this.sessionConfigured = true;
    this.reconnectAttempts = 0;
    for (const chunk of this.pendingAudio.splice(0)) {
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

  private canSubmitToolResult(): boolean {
    return this.connected && this.sessionConfigured && this.ws?.readyState === WebSocket.OPEN;
  }

  private canSubmitInput(): boolean {
    return this.connected && this.sessionConfigured && this.ws?.readyState === WebSocket.OPEN;
  }
}
