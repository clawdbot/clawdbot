import { randomUUID } from "node:crypto";
import { createProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import WebSocket from "ws";
import {
  asFiniteNumber,
  captureOpenAIRealtimeWsClose,
  readRealtimeErrorDetail,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";

export type OpenAIRealtimeVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "cedar"
  | "coral"
  | "echo"
  | "marin"
  | "sage"
  | "shimmer"
  | "verse";

type OpenAIRealtimeVoiceProviderConfig = {
  apiKey?: string;
  model?: string;
  voice?: OpenAIRealtimeVoice;
  temperature?: number;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
};

type OpenAIRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey: string;
  model?: string;
  voice?: OpenAIRealtimeVoice;
  temperature?: number;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
};

const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-1.5";

type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  error?: unknown;
};

type RealtimeSessionUpdate = {
  type: "session.update";
  session: {
    modalities: string[];
    instructions?: string;
    voice: OpenAIRealtimeVoice;
    input_audio_format: string;
    output_audio_format: string;
    turn_detection: {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
      create_response: boolean;
    };
    temperature: number;
    input_audio_transcription?: { model: string };
    tools?: RealtimeVoiceTool[];
    tool_choice?: string;
  };
};

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): OpenAIRealtimeVoiceProviderConfig {
  const raw = resolveOpenAIProviderConfigRecord(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.openai.apiKey",
    }),
    model: trimToUndefined(raw?.model),
    voice: trimToUndefined(raw?.voice) as OpenAIRealtimeVoice | undefined,
    temperature: asFiniteNumber(raw?.temperature),
    vadThreshold: asFiniteNumber(raw?.vadThreshold),
    silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
    prefixPaddingMs: asFiniteNumber(raw?.prefixPaddingMs),
    azureEndpoint: trimToUndefined(raw?.azureEndpoint),
    azureDeployment: trimToUndefined(raw?.azureDeployment),
    azureApiVersion: trimToUndefined(raw?.azureApiVersion),
  };
}

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

class OpenAIRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = OPENAI_REALTIME_DEFAULT_MODEL;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;

  constructor(private readonly config: OpenAIRealtimeVoiceBridgeConfig) {}

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
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
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected() || !this.ws) {
      return;
    }
    this.sendEvent({
      type: "response.create",
      response: {
        instructions: instructions ?? this.config.instructions,
      },
    });
  }

  submitToolResult(callId: string, result: unknown): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  acknowledgeMark(): void {
    if (this.markQueue.length === 0) {
      return;
    }
    this.markQueue.shift();
    if (this.markQueue.length === 0) {
      this.responseStartTimestamp = null;
      this.lastAssistantItemId = null;
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let connectTimeout: ReturnType<typeof setTimeout>;
      let settled = false;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };
      const { url, headers } = this.resolveConnectionParams();
      const debugProxy = resolveDebugProxySettings();
      const proxyAgent = createDebugProxyWebSocketAgent(debugProxy);
      this.ws = new WebSocket(url, {
        headers,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });

      connectTimeout = setTimeout(() => {
        if (!this.connected && !this.intentionallyClosed) {
          this.ws?.terminate();
          settleReject(new Error("OpenAI realtime connection timeout"));
        }
      }, OpenAIRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        this.connected = true;
        this.sessionConfigured = false;
        this.reconnectAttempts = 0;
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
        settleResolve();
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
            capability: "realtime-voice",
          },
        });
        try {
          this.handleEvent(JSON.parse(data.toString()) as RealtimeEvent);
        } catch (error) {
          console.error("[openai] realtime event parse failed:", error);
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
            capability: "realtime-voice",
          },
        });
        if (!this.connected) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on("close", (code, reasonBuffer) => {
        captureOpenAIRealtimeWsClose({
          url,
          flowId: this.flowId,
          capability: "realtime-voice",
          code,
          reasonBuffer,
        });
        this.connected = false;
        this.sessionConfigured = false;
        if (this.intentionallyClosed) {
          settleResolve();
          this.config.onClose?.("completed");
          return;
        }
        void this.attemptReconnect();
      });
    });
  }

  private resolveConnectionParams(): { url: string; headers: Record<string, string> } {
    const cfg = this.config;
    if (cfg.azureEndpoint && cfg.azureDeployment) {
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      const apiVersion = cfg.azureApiVersion ?? "2024-10-01-preview";
      return {
        url: `${base}/openai/realtime?api-version=${apiVersion}&deployment=${encodeURIComponent(
          cfg.azureDeployment,
        )}`,
        headers: { "api-key": cfg.apiKey },
      };
    }

    if (cfg.azureEndpoint) {
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      return {
        url: `${base}/v1/realtime?model=${encodeURIComponent(
          cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
        )}`,
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      };
    }

    return {
      url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
        cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
      )}`,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    };
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS) {
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const delay =
      OpenAIRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.intentionallyClosed) {
      return;
    }
    try {
      await this.doConnect();
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect();
    }
  }

  private sendSessionUpdate(): void {
    const cfg = this.config;
    const sessionUpdate: RealtimeSessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: cfg.instructions,
        voice: cfg.voice ?? "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: cfg.vadThreshold ?? 0.5,
          prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
          silence_duration_ms: cfg.silenceDurationMs ?? 500,
          create_response: true,
        },
        temperature: cfg.temperature ?? 0.8,
        ...(cfg.tools && cfg.tools.length > 0
          ? {
              tools: cfg.tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };
    this.sendEvent(sessionUpdate);
  }

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case "session.created":
        return;

      case "session.updated":
        this.sessionConfigured = true;
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
        }
        if (!this.sessionReadyFired) {
          this.sessionReadyFired = true;
          this.config.onReady?.();
        }
        return;

      case "response.audio.delta": {
        if (!event.delta) {
          return;
        }
        const audio = base64ToBuffer(event.delta);
        this.config.onAudio(audio);
        if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        if (event.item_id) {
          this.lastAssistantItemId = event.item_id;
        }
        this.sendMark();
        return;
      }

      case "input_audio_buffer.speech_started":
        this.handleBargeIn();
        return;

      case "response.audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.audio_transcript.done":
        if (event.transcript) {
          this.config.onTranscript?.("assistant", event.transcript, true);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }

      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buffered = this.toolCallBuffers.get(key);
        if (this.config.onToolCall) {
          const rawArgs =
            buffered?.args ||
            ((event as unknown as Record<string, unknown>).arguments as string) ||
            "{}";
          let args: unknown = {};
          try {
            args = JSON.parse(rawArgs);
          } catch {}
          this.config.onToolCall({
            itemId: key,
            callId: buffered?.callId || event.call_id || "",
            name: buffered?.name || event.name || "",
            args,
          });
        }
        this.toolCallBuffers.delete(key);
        return;
      }

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        this.config.onError?.(new Error(detail));
        return;
      }

      default:
        return;
    }
  }

  private handleBargeIn(): void {
    if (this.markQueue.length > 0 && this.responseStartTimestamp !== null) {
      const elapsedMs = this.latestMediaTimestamp - this.responseStartTimestamp;
      if (this.lastAssistantItemId) {
        this.sendEvent({
          type: "conversation.item.truncate",
          item_id: this.lastAssistantItemId,
          content_index: 0,
          audio_end_ms: Math.max(0, elapsedMs),
        });
      }
      this.config.onClearAudio();
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio();
  }

  private sendMark(): void {
    const markName = `audio-${Date.now()}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(event);
      captureWsEvent({
        url: this.resolveConnectionParams().url,
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
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

async function createOpenAIRealtimeBrowserSession(
  req: RealtimeVoiceBrowserSessionCreateRequest,
): Promise<RealtimeVoiceBrowserSession> {
  const config = normalizeProviderConfig(req.providerConfig);
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key missing");
  }
  if (config.azureEndpoint || config.azureDeployment) {
    throw new Error("OpenAI Realtime browser sessions do not support Azure endpoints yet");
  }

  const model = req.model ?? config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
  const voice = (req.voice ?? config.voice ?? "alloy") as OpenAIRealtimeVoice;
  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions: req.instructions,
    audio: {
      output: { voice },
    },
  };
  if (req.tools && req.tools.length > 0) {
    session.tools = req.tools;
    session.tool_choice = "auto";
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: "https://api.openai.com/v1/realtime/client_secrets",
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session }),
    },
    auditContext: "openai-realtime-browser-session",
  });
  const payload = await (async () => {
    try {
      if (!response.ok) {
        throw await createProviderHttpError(response, "OpenAI Realtime browser session failed");
      }
      return (await response.json()) as unknown;
    } finally {
      await release();
    }
  })();
  const nestedSecret =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).client_secret
      : undefined;
  const clientSecret = readStringField(payload, "value") ?? readStringField(nestedSecret, "value");
  if (!clientSecret) {
    throw new Error("OpenAI Realtime browser session did not return a client secret");
  }
  const expiresAt =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).expires_at
      : undefined;
  return {
    provider: "openai",
    clientSecret,
    model,
    voice,
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
  };
}

export function buildOpenAIRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI Realtime Voice",
    autoSelectOrder: 10,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.OPENAI_API_KEY),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      return new OpenAIRealtimeVoiceBridge({
        ...req,
        apiKey,
        model: config.model,
        voice: config.voice,
        temperature: config.temperature,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        azureEndpoint: config.azureEndpoint,
        azureDeployment: config.azureDeployment,
        azureApiVersion: config.azureApiVersion,
      });
    },
    createBrowserSession: createOpenAIRealtimeBrowserSession,
  };
}

export type { OpenAIRealtimeVoiceProviderConfig };
