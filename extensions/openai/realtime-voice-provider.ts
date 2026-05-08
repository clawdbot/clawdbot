import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createProviderHttpError,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import WebSocket from "ws";
import {
  asFiniteNumber,
  captureOpenAIRealtimeWsClose,
  readRealtimeErrorDetail,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";

type OpenAIRealtimeVoice =
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

const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-2";

type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
  };
  error?: unknown;
};

type RealtimeSessionUpdate = {
  type: "session.update";
  session: RealtimeSessionUpdatePayload;
};

type RealtimeSessionUpdatePayload =
  | RealtimeSessionUpdateGaPayload
  | RealtimeSessionUpdateBetaPayload;

type RealtimeSessionUpdateGaPayload = {
  type: "realtime";
  model: string;
  instructions?: string;
  output_modalities: ["audio"];
  audio: {
    input: {
      format: RealtimeAudioFormatConfig;
      transcription: { model: string };
      turn_detection: {
        type: "server_vad";
        threshold: number;
        prefix_padding_ms: number;
        silence_duration_ms: number;
        create_response: boolean;
        interrupt_response: boolean;
      };
    };
    output: {
      format: RealtimeAudioFormatConfig;
      voice: OpenAIRealtimeVoice;
    };
  };
  tools?: RealtimeVoiceTool[];
  tool_choice?: string;
};

type RealtimeSessionUpdateBetaPayload = {
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

type RealtimeAudioFormatConfig = { type: "audio/pcmu" } | { type: "audio/pcm"; rate: 24000 };

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

type OpenAIRealtimeApiKeyResolution =
  | { status: "available"; value: string }
  | { status: "missing" };

const KEYCHAIN_SECRET_REF_RE = /^keychain:([^:]+):([^:]+)$/;
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 5000;
const resolvedKeychainSecretRefCache = new Map<string, string>();

function resolveKeychainSecretRef(value: string): string | undefined {
  const trimmed = value.trim();
  const match = KEYCHAIN_SECRET_REF_RE.exec(trimmed);
  if (!match) {
    return trimmed || undefined;
  }
  const cached = resolvedKeychainSecretRefCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const [, service, account] = match;
  try {
    const resolved =
      execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
        },
      ).trim() || undefined;
    if (resolved) {
      resolvedKeychainSecretRefCache.set(trimmed, resolved);
    }
    return resolved;
  } catch {
    return undefined;
  }
}

function resolveOpenAIRealtimeApiKey(
  configuredApiKey: string | undefined,
): OpenAIRealtimeApiKeyResolution {
  const configured = normalizeSecretInputString(configuredApiKey);
  if (configured) {
    const value = resolveKeychainSecretRef(configured);
    return value ? { status: "available", value } : { status: "missing" };
  }

  const envValue = normalizeSecretInputString(process.env.OPENAI_API_KEY);
  if (!envValue) {
    return { status: "missing" };
  }
  const value = resolveKeychainSecretRef(envValue);
  return value ? { status: "available", value } : { status: "missing" };
}

function requireOpenAIRealtimeApiKey(configuredApiKey: string | undefined): string {
  const resolved = resolveOpenAIRealtimeApiKey(configuredApiKey);
  if (resolved.status === "available") {
    return resolved.value;
  }
  throw new Error("OpenAI API key missing");
}

function hasOpenAIRealtimeApiKeyInput(configuredApiKey: string | undefined): boolean {
  return Boolean(
    normalizeSecretInputString(configuredApiKey) ??
    normalizeSecretInputString(process.env.OPENAI_API_KEY),
  );
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
  private responseActive = false;
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;
  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(private readonly config: OpenAIRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
  }

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
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the meeting.");
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
        if (!this.sessionConfigured && !this.intentionallyClosed) {
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
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          this.handleEvent(event);
          if (event.type === "session.updated") {
            settleResolve();
          }
          if (event.type === "error" && !this.sessionConfigured) {
            settleReject(new Error(readRealtimeErrorDetail(event.error)));
          }
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
        if (!this.sessionConfigured) {
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
        if (!this.sessionConfigured && !settled) {
          settleReject(new Error("OpenAI realtime connection closed before ready"));
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
          defaultHeaders: { "api-key": cfg.apiKey },
        }) ?? { "api-key": cfg.apiKey },
      };
    }

    if (cfg.azureEndpoint) {
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      const url = `${base}/v1/realtime?model=${encodeURIComponent(
        cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
      )}`;
      return {
        url,
        headers: resolveProviderRequestHeaders({
          provider: "openai",
          baseUrl: url,
          capability: "audio",
          transport: "websocket",
          defaultHeaders: { Authorization: `Bearer ${cfg.apiKey}` },
        }) ?? { Authorization: `Bearer ${cfg.apiKey}` },
      };
    }

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
    )}`;
    return {
      url,
      headers: resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: url,
        capability: "audio",
        transport: "websocket",
        defaultHeaders: {
          Authorization: `Bearer ${cfg.apiKey}`,
        },
      }) ?? {
        Authorization: `Bearer ${cfg.apiKey}`,
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
    this.sendEvent({
      type: "session.update",
      session: this.resolveSessionUpdatePayload(),
    } satisfies RealtimeSessionUpdate);
  }

  private resolveSessionUpdatePayload(): RealtimeSessionUpdatePayload {
    if (this.usesAzureDeploymentRealtimeApi()) {
      return this.resolveBetaSessionUpdatePayload();
    }
    return this.resolveGaSessionUpdatePayload();
  }

  private usesAzureDeploymentRealtimeApi(): boolean {
    return Boolean(this.config.azureEndpoint && this.config.azureDeployment);
  }

  private resolveGaSessionUpdatePayload(): RealtimeSessionUpdateGaPayload {
    const cfg = this.config;
    const autoRespondToAudio = cfg.autoRespondToAudio ?? true;
    return {
      type: "realtime",
      model: cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
      instructions: cfg.instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: this.resolveRealtimeAudioFormatConfig(),
          transcription: {
            model: "whisper-1",
          },
          turn_detection: {
            type: "server_vad",
            threshold: cfg.vadThreshold ?? 0.5,
            prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
            silence_duration_ms: cfg.silenceDurationMs ?? 500,
            create_response: autoRespondToAudio,
            interrupt_response: autoRespondToAudio,
          },
        },
        output: {
          format: this.resolveRealtimeAudioFormatConfig(),
          voice: cfg.voice ?? "alloy",
        },
      },
      ...(cfg.tools && cfg.tools.length > 0
        ? {
            tools: cfg.tools,
            tool_choice: "auto",
          }
        : {}),
    };
  }

  private resolveBetaSessionUpdatePayload(): RealtimeSessionUpdateBetaPayload {
    const cfg = this.config;
    return {
      modalities: ["text", "audio"],
      instructions: cfg.instructions,
      voice: cfg.voice ?? "alloy",
      input_audio_format: this.resolveRealtimeAudioFormat(),
      output_audio_format: this.resolveRealtimeAudioFormat(),
      input_audio_transcription: {
        model: "whisper-1",
      },
      turn_detection: {
        type: "server_vad",
        threshold: cfg.vadThreshold ?? 0.5,
        prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
        silence_duration_ms: cfg.silenceDurationMs ?? 500,
        create_response: cfg.autoRespondToAudio ?? true,
      },
      temperature: cfg.temperature ?? 0.8,
      ...(cfg.tools && cfg.tools.length > 0
        ? {
            tools: cfg.tools,
            tool_choice: "auto",
          }
        : {}),
    };
  }

  private resolveRealtimeAudioFormatConfig(): RealtimeAudioFormatConfig {
    return this.audioFormat.encoding === "pcm16"
      ? { type: "audio/pcm", rate: 24000 }
      : { type: "audio/pcmu" };
  }

  private resolveRealtimeAudioFormat(): "g711_ulaw" | "pcm16" {
    return this.audioFormat.encoding === "pcm16" ? "pcm16" : "g711_ulaw";
  }

  private handleEvent(event: RealtimeEvent): void {
    this.config.onEvent?.({
      direction: "server",
      type: event.type,
      detail: this.describeServerEvent(event),
    });
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

      case "response.created":
        this.responseActive = true;
        return;

      case "response.audio.delta":
      case "response.output_audio.delta": {
        if (!event.delta) {
          return;
        }
        const audio = base64ToBuffer(event.delta);
        this.config.onAudio(audio);
        if (event.item_id && event.item_id !== this.lastAssistantItemId) {
          this.lastAssistantItemId = event.item_id;
          this.responseStartTimestamp = this.latestMediaTimestamp;
        } else if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        this.responseActive = true;
        this.sendMark();
        return;
      }

      case "input_audio_buffer.speech_started":
        if (this.config.autoRespondToAudio ?? true) {
          this.handleBargeIn();
        }
        return;

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
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

      case "response.done":
        this.responseActive = false;
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

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    const assistantItemId = this.lastAssistantItemId;
    const responseStartTimestamp = this.responseStartTimestamp;
    const shouldInterruptProvider =
      responseStartTimestamp !== null &&
      assistantItemId !== null &&
      (this.markQueue.length > 0 || options?.audioPlaybackActive === true);
    if (options?.audioPlaybackActive === true && this.responseActive) {
      this.sendEvent({ type: "response.cancel" });
    }
    if (shouldInterruptProvider) {
      const elapsedMs = this.latestMediaTimestamp - responseStartTimestamp;
      this.sendEvent({
        type: "conversation.item.truncate",
        item_id: assistantItemId,
        content_index: 0,
        audio_end_ms: Math.max(0, elapsedMs),
      });
      this.config.onClearAudio();
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      this.responseActive = false;
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
      const type =
        event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
          ? (event as { type: string }).type
          : "unknown";
      this.config.onEvent?.({ direction: "client", type });
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

  private describeServerEvent(event: RealtimeEvent): string | undefined {
    if (event.type === "error") {
      return readRealtimeErrorDetail(event.error);
    }
    if (event.type === "response.done") {
      const status = event.response?.status;
      const details =
        event.response?.status_details === undefined
          ? undefined
          : JSON.stringify(event.response.status_details);
      return (
        [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined
      );
    }
    return undefined;
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function resolveOpenAIRealtimeBrowserOfferHeaders(): Record<string, string> | undefined {
  const headers = resolveProviderRequestHeaders({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1/realtime/calls",
    capability: "audio",
    transport: "http",
    defaultHeaders: {},
  });
  // Strip server-side-only attribution headers: browser direct fetches to
  // api.openai.com fail CORS preflight when these are present (only
  // authorization,content-type are allowed by the endpoint's CORS policy).
  const SERVER_ONLY_HEADERS = new Set(["user-agent", "originator", "version"]);
  const browserHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => !SERVER_ONLY_HEADERS.has(key.toLowerCase())),
  );
  return Object.keys(browserHeaders).length > 0 ? browserHeaders : undefined;
}

async function createOpenAIRealtimeBrowserSession(
  req: RealtimeVoiceBrowserSessionCreateRequest,
): Promise<RealtimeVoiceBrowserSession> {
  const config = normalizeProviderConfig(req.providerConfig);
  const apiKey = requireOpenAIRealtimeApiKey(config.apiKey);
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
      input: {
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
        },
        transcription: { model: "whisper-1" },
      },
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
      headers: resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1/realtime/client_secrets",
        capability: "audio",
        transport: "http",
        defaultHeaders: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }) ?? {
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
  const offerHeaders = resolveOpenAIRealtimeBrowserOfferHeaders();
  return {
    provider: "openai",
    transport: "webrtc",
    clientSecret,
    offerUrl: "https://api.openai.com/v1/realtime/calls",
    ...(offerHeaders ? { offerHeaders } : {}),
    model,
    voice,
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
  };
}

export function buildOpenAIRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI Realtime Voice",
    defaultModel: OPENAI_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 10,
    capabilities: {
      transports: ["webrtc", "gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBrowserSession: true,
      supportsBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      hasOpenAIRealtimeApiKeyInput(normalizeProviderConfig(providerConfig).apiKey),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = requireOpenAIRealtimeApiKey(config.apiKey);
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
