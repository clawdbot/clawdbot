import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  isProviderAuthProfileConfigured,
  resolveProviderAuthProfileApiKey,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
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
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import WebSocket from "ws";
import {
  asFiniteNumber,
  captureOpenAIRealtimeWsClose,
  createOpenAIRealtimeClientSecret,
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
  interruptResponseOnInputAudio?: boolean;
  minBargeInAudioEndMs?: number;
  reasoningEffort?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
};

type OpenAIRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey?: string;
  model?: string;
  voice?: OpenAIRealtimeVoice;
  temperature?: number;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  minBargeInAudioEndMs?: number;
  reasoningEffort?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
};

const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-2";
const OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
const OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";
const OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
const OPENAI_REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const satisfies readonly OpenAIRealtimeVoice[];

function normalizeOpenAIRealtimeVoice(value: unknown): OpenAIRealtimeVoice | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return OPENAI_REALTIME_VOICES.includes(normalized as OpenAIRealtimeVoice)
    ? (normalized as OpenAIRealtimeVoice)
    : undefined;
}

type RealtimeEvent = {
  type: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
  };
  error?: unknown;
};

type RealtimeTurnDetectionConfig = {
  type: "server_vad";
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  create_response: boolean;
  interrupt_response?: boolean;
};

type RealtimeGaSessionUpdate = {
  type: "session.update";
  session: {
    type: "realtime";
    model?: string;
    instructions?: string;
    output_modalities: string[];
    audio: {
      input: {
        format: OpenAIRealtimeAudioFormatConfig;
        turn_detection: RealtimeTurnDetectionConfig;
        noise_reduction?: { type: "near_field" };
        transcription?: { model: string };
      };
      output: {
        format: OpenAIRealtimeAudioFormatConfig;
        voice: OpenAIRealtimeVoice;
      };
    };
    reasoning?: { effort: string };
    tools?: RealtimeVoiceTool[];
    tool_choice?: string;
  };
};

type RealtimeAzureDeploymentSessionUpdate = {
  type: "session.update";
  session: {
    modalities: string[];
    instructions?: string;
    voice: OpenAIRealtimeVoice;
    input_audio_format: "g711_ulaw" | "pcm16";
    output_audio_format: "g711_ulaw" | "pcm16";
    input_audio_transcription?: { model: string };
    turn_detection: RealtimeTurnDetectionConfig;
    temperature: number;
    tools?: RealtimeVoiceTool[];
    tool_choice?: string;
  };
};

type OpenAIRealtimeAudioFormatConfig =
  | {
      type: "audio/pcm";
      rate: 24000;
    }
  | {
      type: "audio/pcmu";
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
    voice: normalizeOpenAIRealtimeVoice(raw?.voice),
    temperature: asFiniteNumber(raw?.temperature),
    vadThreshold: asFiniteNumber(raw?.vadThreshold),
    silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
    prefixPaddingMs: asFiniteNumber(raw?.prefixPaddingMs),
    interruptResponseOnInputAudio:
      typeof raw?.interruptResponseOnInputAudio === "boolean"
        ? raw.interruptResponseOnInputAudio
        : undefined,
    minBargeInAudioEndMs: asNonNegativeInteger(raw?.minBargeInAudioEndMs),
    reasoningEffort: trimToUndefined(raw?.reasoningEffort),
    azureEndpoint: trimToUndefined(raw?.azureEndpoint),
    azureDeployment: trimToUndefined(raw?.azureDeployment),
    azureApiVersion: trimToUndefined(raw?.azureApiVersion),
  };
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number === undefined || number < 0 ? undefined : Math.floor(number);
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

async function resolveOpenAIRealtimeBrowserApiKey(params: {
  configuredApiKey: string | undefined;
  cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
}): Promise<string | undefined> {
  const resolved = resolveOpenAIRealtimeApiKey(params.configuredApiKey);
  if (resolved.status === "available") {
    return resolved.value;
  }
  return await resolveProviderAuthProfileApiKey({
    provider: "openai-codex",
    cfg: params.cfg,
  });
}

async function requireOpenAIRealtimeBrowserApiKey(params: {
  configuredApiKey: string | undefined;
  cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
}): Promise<string> {
  const apiKey = await resolveOpenAIRealtimeBrowserApiKey(params);
  if (apiKey) {
    return apiKey;
  }
  throw new Error("OpenAI API key or Codex OAuth missing");
}

function hasOpenAIRealtimeBrowserAuthInput(params: {
  configuredApiKey: string | undefined;
  cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
}): boolean {
  if (hasOpenAIRealtimeApiKeyInput(params.configuredApiKey)) {
    return true;
  }
  return isProviderAuthProfileConfigured({
    provider: "openai-codex",
    cfg: params.cfg,
  });
}

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

class OpenAIRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = OPENAI_REALTIME_DEFAULT_MODEL;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;
  readonly supportsToolResultContinuation = true;

  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCancelInFlight = false;
  private responseCreatePending = false;
  private continuingToolCallIds = new Set<string>();
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private connectionUrl = "";
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private deliveredToolCallKeys = new Set<string>();
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
    this.requestResponseCreate();
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
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    if (options?.willContinue === true) {
      this.continuingToolCallIds.add(callId);
      return;
    }
    this.continuingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      return;
    }
    this.requestResponseCreate();
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
      connectTimeout = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          this.ws?.terminate();
          settleReject(new Error("OpenAI realtime connection timeout"));
        }
      }, OpenAIRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);

      const openWebSocket = (connection: { url: string; headers: Record<string, string> }) => {
        if (settled) {
          return;
        }
        if (this.intentionallyClosed) {
          settleResolve();
          return;
        }
        const url = connection.url;
        this.connectionUrl = connection.url;
        const debugProxy = resolveDebugProxySettings();
        const proxyAgent = createDebugProxyWebSocketAgent(debugProxy);
        const ws = new WebSocket(connection.url, {
          headers: connection.headers,
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        });
        this.ws = ws;

        ws.on("open", () => {
          this.resetRealtimeSessionState();
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

        ws.on("message", (data: Buffer) => {
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

        ws.on("error", (error) => {
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

        ws.on("close", (code, reasonBuffer) => {
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
      };

      const connectionOrPromise = this.resolveConnectionParams();
      if (connectionOrPromise instanceof Promise) {
        void connectionOrPromise.then(openWebSocket).catch((error: unknown) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      openWebSocket(connectionOrPromise);
    });
  }

  private resolveConnectionParams():
    | { url: string; headers: Record<string, string> }
    | Promise<{ url: string; headers: Record<string, string> }> {
    const cfg = this.config;
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

    const directApiKey = resolveOpenAIRealtimeApiKey(cfg.apiKey);
    if (directApiKey.status === "missing") {
      if (cfg.azureEndpoint) {
        throw new Error("OpenAI API key missing");
      }
      return this.resolveOAuthConnectionParams();
    }
    const apiKey = directApiKey.value;
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
          defaultHeaders: { Authorization: `Bearer ${apiKey}` },
        }) ?? { Authorization: `Bearer ${apiKey}` },
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
          Authorization: `Bearer ${apiKey}`,
        },
      }) ?? {
        Authorization: `Bearer ${apiKey}`,
      },
    };
  }

  private async resolveOAuthConnectionParams(): Promise<{
    url: string;
    headers: Record<string, string>;
  }> {
    const cfg = this.config;
    const authToken = await requireOpenAIRealtimeBrowserApiKey({
      configuredApiKey: cfg.apiKey,
      cfg: cfg.cfg,
    });
    const model = cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL;
    const clientSecret = await createOpenAIRealtimeClientSecret({
      authToken,
      auditContext: "openai-realtime-bridge-session",
      session: {
        type: "realtime",
        model,
        audio: {
          output: { voice: cfg.voice ?? "alloy" },
        },
      },
    });
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    return {
      url,
      headers: resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: url,
        capability: "audio",
        transport: "websocket",
        defaultHeaders: {
          Authorization: `Bearer ${clientSecret.value}`,
        },
      }) ?? {
        Authorization: `Bearer ${clientSecret.value}`,
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
    if (this.usesAzureDeploymentRealtimeApi()) {
      this.sendEvent(this.buildAzureDeploymentSessionUpdate());
      return;
    }

    this.sendEvent(this.buildGaSessionUpdate());
  }

  private buildGaSessionUpdate(): RealtimeGaSessionUpdate {
    const cfg = this.config;
    const autoRespondToAudio = cfg.autoRespondToAudio ?? true;
    const interruptResponseOnInputAudio = cfg.interruptResponseOnInputAudio ?? autoRespondToAudio;
    return {
      type: "session.update",
      session: {
        type: "realtime",
        model: cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
        instructions: cfg.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: this.resolveRealtimeAudioFormat(),
            noise_reduction: { type: "near_field" },
            transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
            turn_detection: {
              type: "server_vad",
              threshold: cfg.vadThreshold ?? 0.5,
              prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
              silence_duration_ms: cfg.silenceDurationMs ?? 500,
              create_response: autoRespondToAudio,
              interrupt_response: interruptResponseOnInputAudio,
            },
          },
          output: {
            format: this.resolveRealtimeAudioFormat(),
            voice: cfg.voice ?? "alloy",
          },
        },
        ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
        ...(cfg.tools && cfg.tools.length > 0
          ? {
              tools: cfg.tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };
  }

  private usesAzureDeploymentRealtimeApi(): boolean {
    return Boolean(this.config.azureEndpoint && this.config.azureDeployment);
  }

  private buildAzureDeploymentSessionUpdate(): RealtimeAzureDeploymentSessionUpdate {
    const cfg = this.config;
    const format = this.resolveLegacyRealtimeAudioFormat();
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: cfg.instructions,
        voice: cfg.voice ?? "alloy",
        input_audio_format: format,
        output_audio_format: format,
        input_audio_transcription: { model: "whisper-1" },
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
      },
    };
  }

  private resolveRealtimeAudioFormat(): OpenAIRealtimeAudioFormatConfig {
    return this.audioFormat.encoding === "pcm16"
      ? { type: "audio/pcm", rate: 24000 }
      : { type: "audio/pcmu" };
  }

  private resolveLegacyRealtimeAudioFormat(): "g711_ulaw" | "pcm16" {
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
        this.responseCreateInFlight = false;
        return;

      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (!audioDelta) {
          return;
        }
        const audio = base64ToBuffer(audioDelta);
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
        if (this.config.interruptResponseOnInputAudio ?? this.config.autoRespondToAudio ?? true) {
          this.handleBargeIn();
        }
        return;

      case "conversation.output_transcript.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        {
          const transcript = event.transcript ?? event.text;
          if (transcript) {
            this.config.onTranscript?.("assistant", transcript, true);
          }
        }
        return;

      case "conversation.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.responseCreateInFlight = false;
        this.responseCancelInFlight = false;
        this.flushPendingResponseCreate();
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
        this.emitToolCallOnce({
          itemId: event.item_id,
          callId: buffered?.callId || event.call_id,
          name: buffered?.name || event.name,
          rawArgs: buffered?.args || event.arguments,
        });
        this.toolCallBuffers.delete(key);
        return;
      }

      case "conversation.item.done": {
        if (event.item?.type !== "function_call") {
          return;
        }
        this.emitToolCallOnce({
          itemId: event.item.id ?? event.item_id,
          callId: event.item.call_id ?? event.call_id ?? event.item.id ?? event.item_id,
          name: event.item.name ?? event.name,
          rawArgs: event.item.arguments ?? event.arguments,
        });
        return;
      }

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        if (detail.startsWith(OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)) {
          this.responseActive = true;
          this.responseCreateInFlight = false;
          this.responseCreatePending = true;
          return;
        }
        if (detail === OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
          this.responseActive = false;
          this.responseCancelInFlight = false;
          this.flushPendingResponseCreate();
          return;
        }
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
    const force = options?.force === true;
    const shouldInterruptProvider =
      assistantItemId !== null &&
      ((responseStartTimestamp !== null &&
        (this.markQueue.length > 0 || options?.audioPlaybackActive === true)) ||
        force);
    const audioEndMs = shouldInterruptProvider
      ? Math.max(
          0,
          responseStartTimestamp === null
            ? this.latestMediaTimestamp
            : this.latestMediaTimestamp - responseStartTimestamp,
        )
      : null;
    const minBargeInAudioEndMs =
      this.config.minBargeInAudioEndMs ?? OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
    if (!force && audioEndMs !== null && audioEndMs < minBargeInAudioEndMs) {
      this.config.onEvent?.({
        direction: "client",
        type: "conversation.item.truncate.skipped",
        detail: `reason=barge-in audioEndMs=${audioEndMs} minAudioEndMs=${minBargeInAudioEndMs}`,
      });
      return;
    }
    if (
      options?.audioPlaybackActive === true &&
      this.responseActive &&
      !this.responseCancelInFlight
    ) {
      this.sendEvent({ type: "response.cancel" }, "reason=barge-in");
      this.responseCancelInFlight = true;
    }
    if (shouldInterruptProvider) {
      this.sendEvent(
        {
          type: "conversation.item.truncate",
          item_id: assistantItemId,
          content_index: 0,
          audio_end_ms: audioEndMs,
        },
        `reason=barge-in audioEndMs=${audioEndMs}`,
      );
      this.config.onClearAudio();
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio();
  }

  private emitToolCallOnce(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): void {
    if (!this.config.onToolCall) {
      return;
    }
    const itemId = fields.itemId || fields.callId || "unknown";
    const callId = fields.callId || itemId;
    const name = fields.name || "";
    const dedupeKey = fields.itemId || fields.callId || `${name}:${fields.rawArgs ?? ""}`;
    if (this.deliveredToolCallKeys.has(dedupeKey)) {
      return;
    }
    this.deliveredToolCallKeys.add(dedupeKey);
    let args: unknown = {};
    try {
      args = JSON.parse(fields.rawArgs || "{}");
    } catch {}
    this.config.onToolCall({
      itemId,
      callId,
      name,
      args,
    });
  }

  private requestResponseCreate(): void {
    if (
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.continuingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.sendEvent({ type: "response.create" });
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private resetRealtimeSessionState(): void {
    this.markQueue = [];
    this.responseStartTimestamp = null;
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCancelInFlight = false;
    this.responseCreatePending = false;
    this.continuingToolCallIds.clear();
    this.lastAssistantItemId = null;
    this.toolCallBuffers.clear();
    this.deliveredToolCallKeys.clear();
  }

  private sendMark(): void {
    const markName = `audio-${Date.now()}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  private sendEvent(event: unknown, detail?: string): void {
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
    if (event.type === "response.cancelled") {
      return "cancelled";
    }
    if (event.type === "conversation.item.done" && event.item?.type) {
      return [event.item.type, event.item.name ? `name=${event.item.name}` : undefined]
        .filter(Boolean)
        .join(" ");
    }
    return undefined;
  }
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
  const apiKey = await requireOpenAIRealtimeBrowserApiKey({
    configuredApiKey: config.apiKey,
    cfg: req.cfg,
  });
  if (config.azureEndpoint || config.azureDeployment) {
    throw new Error("OpenAI Realtime browser sessions do not support Azure endpoints yet");
  }

  const model = req.model ?? config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
  const voice = normalizeOpenAIRealtimeVoice(req.voice) ?? config.voice ?? "alloy";
  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions: req.instructions,
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          ...(typeof (req.vadThreshold ?? config.vadThreshold) === "number"
            ? { threshold: req.vadThreshold ?? config.vadThreshold }
            : {}),
          ...(typeof (req.prefixPaddingMs ?? config.prefixPaddingMs) === "number"
            ? { prefix_padding_ms: req.prefixPaddingMs ?? config.prefixPaddingMs }
            : {}),
          ...(typeof (req.silenceDurationMs ?? config.silenceDurationMs) === "number"
            ? { silence_duration_ms: req.silenceDurationMs ?? config.silenceDurationMs }
            : {}),
        },
        transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
      },
      output: { voice },
    },
  };
  if (req.tools && req.tools.length > 0) {
    session.tools = req.tools;
    session.tool_choice = "auto";
  }
  const reasoningEffort = trimToUndefined(req.reasoningEffort) ?? config.reasoningEffort;
  if (reasoningEffort) {
    session.reasoning = { effort: reasoningEffort };
  }

  const clientSecret = await createOpenAIRealtimeClientSecret({
    authToken: apiKey,
    auditContext: "openai-realtime-browser-session",
    session,
  });
  const offerHeaders = resolveOpenAIRealtimeBrowserOfferHeaders();
  return {
    provider: "openai",
    transport: "webrtc",
    clientSecret: clientSecret.value,
    offerUrl: "https://api.openai.com/v1/realtime/calls",
    ...(offerHeaders ? { offerHeaders } : {}),
    model,
    voice,
    ...(typeof clientSecret.expiresAt === "number" ? { expiresAt: clientSecret.expiresAt } : {}),
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
    isConfigured: ({ cfg, providerConfig }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.azureEndpoint || config.azureDeployment) {
        return hasOpenAIRealtimeApiKeyInput(config.apiKey);
      }
      return hasOpenAIRealtimeBrowserAuthInput({
        configuredApiKey: config.apiKey,
        cfg,
      });
    },
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      return new OpenAIRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        model: config.model,
        voice: config.voice,
        temperature: config.temperature,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        interruptResponseOnInputAudio:
          req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio,
        minBargeInAudioEndMs: config.minBargeInAudioEndMs,
        reasoningEffort: config.reasoningEffort,
        azureEndpoint: config.azureEndpoint,
        azureDeployment: config.azureDeployment,
        azureApiVersion: config.azureApiVersion,
      });
    },
    createBrowserSession: createOpenAIRealtimeBrowserSession,
  };
}
