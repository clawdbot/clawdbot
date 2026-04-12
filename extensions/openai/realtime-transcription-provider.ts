import { randomUUID } from "node:crypto";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import WebSocket from "ws";
import {
  asFiniteNumber,
  readRealtimeErrorDetail,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";

type OpenAIRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  model?: string;
  silenceDurationMs?: number;
  vadThreshold?: number;
};

type OpenAIRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  model: string;
  silenceDurationMs: number;
  vadThreshold: number;
};

type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  error?: unknown;
};

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): OpenAIRealtimeTranscriptionProviderConfig {
  const raw = resolveOpenAIProviderConfigRecord(config);
  return {
    apiKey:
      normalizeResolvedSecretInputString({
        value: raw?.apiKey,
        path: "plugins.entries.voice-call.config.streaming.providers.openai.apiKey",
      }) ??
      normalizeResolvedSecretInputString({
        value: raw?.openaiApiKey,
        path: "plugins.entries.voice-call.config.streaming.openaiApiKey",
      }),
    model: trimToUndefined(raw?.model) ?? trimToUndefined(raw?.sttModel),
    silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
    vadThreshold: asFiniteNumber(raw?.vadThreshold),
  };
}

class OpenAIRealtimeTranscriptionSession implements RealtimeTranscriptionSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingTranscript = "";
  private readonly flowId = randomUUID();

  constructor(private readonly config: OpenAIRealtimeTranscriptionSessionConfig) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    if (this.ws) {
      this.ws.close(1000, "Transcription session closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const url = "wss://api.openai.com/v1/realtime?intent=transcription";
      const debugProxy = resolveDebugProxySettings();
      const proxyAgent = createDebugProxyWebSocketAgent(debugProxy);
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });

      const connectTimeout = setTimeout(() => {
        reject(new Error("OpenAI realtime transcription connection timeout"));
      }, OpenAIRealtimeTranscriptionSession.CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
          meta: {
            provider: "openai",
            capability: "realtime-transcription",
          },
        });
        this.sendEvent({
          type: "transcription_session.update",
          session: {
            input_audio_format: "g711_ulaw",
            input_audio_transcription: {
              model: this.config.model,
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.config.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.config.silenceDurationMs,
            },
          },
        });
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: data,
          meta: {
            provider: "openai",
            capability: "realtime-transcription",
          },
        });
        try {
          this.handleEvent(JSON.parse(data.toString()) as RealtimeEvent);
        } catch (error) {
          this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });

      this.ws.on("error", (error) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: error instanceof Error ? error.message : String(error),
          meta: {
            provider: "openai",
            capability: "realtime-transcription",
          },
        });
        if (!this.connected) {
          clearTimeout(connectTimeout);
          reject(error);
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on("close", (code, reasonBuffer) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: this.flowId,
          closeCode: typeof code === "number" ? code : undefined,
          meta: {
            provider: "openai",
            capability: "realtime-transcription",
            reason:
              Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
                ? reasonBuffer.toString("utf8")
                : undefined,
          },
        });
        this.connected = false;
        if (this.closed) {
          return;
        }
        void this.attemptReconnect();
      });
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.reconnectAttempts >= OpenAIRealtimeTranscriptionSession.MAX_RECONNECT_ATTEMPTS) {
      this.config.onError?.(new Error("OpenAI realtime transcription reconnect limit reached"));
      return;
    }
    this.reconnectAttempts += 1;
    const delay =
      OpenAIRealtimeTranscriptionSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.closed) {
      return;
    }
    try {
      await this.doConnect();
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect();
    }
  }

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.pendingTranscript += event.delta;
          this.config.onPartial?.(this.pendingTranscript);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.(event.transcript);
        }
        this.pendingTranscript = "";
        return;

      case "input_audio_buffer.speech_started":
        this.pendingTranscript = "";
        this.config.onSpeechStart?.();
        return;

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        this.config.onError?.(new Error(detail));
        return;
      }

      default:
        return;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(event);
      captureWsEvent({
        url: "wss://api.openai.com/v1/realtime?intent=transcription",
        direction: "outbound",
        kind: "ws-frame",
        flowId: this.flowId,
        payload,
        meta: {
          provider: "openai",
          capability: "realtime-transcription",
        },
      });
      this.ws.send(payload);
    }
  }
}

export function buildOpenAIRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI Realtime Transcription",
    aliases: ["openai-realtime"],
    autoSelectOrder: 10,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.OPENAI_API_KEY),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      return new OpenAIRealtimeTranscriptionSession({
        ...req,
        apiKey,
        model: config.model ?? "gpt-4o-transcribe",
        silenceDurationMs: config.silenceDurationMs ?? 800,
        vadThreshold: config.vadThreshold ?? 0.5,
      });
    },
  };
}
