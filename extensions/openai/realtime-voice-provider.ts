// Openai provider module implements model/runtime integration.
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
import { warn } from "openclaw/plugin-sdk/runtime-env";
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
import {
  isOpenAIGptLiveModel,
  OPENAI_GPT_LIVE_BRIDGE_UNSUPPORTED_MESSAGE,
  OPENAI_GPT_LIVE_BROWSER_SESSION_UNSUPPORTED_MESSAGE,
} from "./realtime-quicksilver.js";

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

const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-2.1";
const OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
const OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";
const OPENAI_REALTIME_MAX_SESSION_DURATION_FRAGMENT = "maximum duration";
const OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
// Realtime validates this character set but accepts names beyond the 64-character
// cap used by other OpenAI tool surfaces.
const OPENAI_REALTIME_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
const AZURE_OPENAI_REALTIME_TOOL_NAME_MAX_LENGTH = 64;
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
  response_id?: string;
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
        noise_reduction?: { type: "near_field" } | null;
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
    voice: normalizeOpenAIRealtimeVoice(raw?.speakerVoice ?? raw?.voice),
    temperature: asFiniteNumber(raw?.temperature),
    vadThreshold: asUnitInterval(raw?.vadThreshold),
    silenceDurationMs: asNonNegativeInteger(raw?.silenceDurationMs),
    prefixPaddingMs: asNonNegativeInteger(raw?.prefixPaddingMs),
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
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function asUnitInterval(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

type OpenAIRealtimeApiKeyResolution =
  | { status: "available"; value: string }
  | { status: "missing" };

const OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED =
  "OpenAI Realtime voice requires an OpenAI Platform API key";
const OPENAI_REALTIME_API_KEY_REQUIRED = "OpenAI Realtime voice requires an API key";
const OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED =
  "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source";
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
  if (!service || !account) {
    return undefined;
  }
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

function resolveOpenAIRealtimeSecretInput(
  configuredApiKey: string | undefined,
): OpenAIRealtimeApiKeyResolution {
  const configured = normalizeSecretInputString(configuredApiKey);
  if (configured) {
    const value = resolveKeychainSecretRef(configured);
    return value ? { status: "available", value } : { status: "missing" };
  }

  return { status: "missing" };
}

function resolveOpenAIRealtimeEnvApiKey(): OpenAIRealtimeApiKeyResolution {
  const envValue = normalizeSecretInputString(process.env.OPENAI_API_KEY);
  if (!envValue) {
    return { status: "missing" };
  }
  const value = resolveKeychainSecretRef(envValue);
  return value ? { status: "available", value } : { status: "missing" };
}

function resolveOpenAIRealtimeApiKey(
  configuredApiKey: string | undefined,
): OpenAIRealtimeApiKeyResolution {
  const configured = resolveOpenAIRealtimeSecretInput(configuredApiKey);
  if (
    configured.status === "available" ||
    hasOpenAIRealtimeConfiguredApiKeyInput(configuredApiKey)
  ) {
    return configured;
  }
  return resolveOpenAIRealtimeEnvApiKey();
}

function requireOpenAIRealtimeApiKey(
  configuredApiKey: string | undefined,
  errorMessage = OPENAI_REALTIME_API_KEY_REQUIRED,
): string {
  const resolved = resolveOpenAIRealtimeApiKey(configuredApiKey);
  if (resolved.status === "available") {
    return resolved.value;
  }
  throw new Error(errorMessage);
}

function hasOpenAIRealtimeConfiguredApiKeyInput(configuredApiKey: string | undefined): boolean {
  return Boolean(normalizeSecretInputString(configuredApiKey));
}

function hasOpenAIRealtimeApiKeyInput(configuredApiKey: string | undefined): boolean {
  return Boolean(
    normalizeSecretInputString(configuredApiKey) ??
    normalizeSecretInputString(process.env.OPENAI_API_KEY),
  );
}

function normalizeOpenAIRealtimeTools(
  tools: RealtimeVoiceTool[] | undefined,
  maxNameLength?: number,
): RealtimeVoiceTool[] | undefined {
  const normalized: RealtimeVoiceTool[] = [];
  let omitted = 0;
  for (const tool of tools ?? []) {
    try {
      const name = tool.name;
      if (typeof name !== "string") {
        omitted += 1;
        continue;
      }
      const exceedsLengthLimit = maxNameLength !== undefined && name.length > maxNameLength;
      if (exceedsLengthLimit || !OPENAI_REALTIME_TOOL_NAME_RE.test(name)) {
        omitted += 1;
        continue;
      }
      normalized.push({
        type: "function",
        name,
        description: tool.description,
        parameters: tool.parameters,
      });
    } catch {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    warn(`openai realtime: omitted ${omitted} tool definition(s) with unsupported names`);
  }
  return normalized.length > 0 ? normalized : undefined;
}

async function resolveOpenAIRealtimePlatformAuth(params: {
  configuredApiKey: string | undefined;
  cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
}): Promise<OpenAIRealtimeApiKeyResolution> {
  const configured = resolveOpenAIRealtimeSecretInput(params.configuredApiKey);
  if (
    configured.status === "available" ||
    hasOpenAIRealtimeConfiguredApiKeyInput(params.configuredApiKey)
  ) {
    return configured;
  }

  const profileApiKey = await resolveProviderAuthProfileApiKey({
    provider: "openai",
    cfg: params.cfg,
    profileTypes: ["api_key"],
  });
  if (profileApiKey) {
    return { status: "available", value: profileApiKey };
  }
  const hasConfiguredApiKeyProfile = isProviderAuthProfileConfigured({
    provider: "openai",
    cfg: params.cfg,
    profileTypes: ["api_key"],
  });

  const envApiKey = resolveOpenAIRealtimeEnvApiKey();
  if (envApiKey.status === "available") {
    return envApiKey;
  }
  if (hasConfiguredApiKeyProfile || hasOpenAIRealtimeApiKeyInput(undefined)) {
    return { status: "missing" };
  }

  return { status: "missing" };
}

async function requireOpenAIRealtimePlatformAuth(params: {
  configuredApiKey: string | undefined;
  cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
}): Promise<Extract<OpenAIRealtimeApiKeyResolution, { status: "available" }>> {
  const resolved = await resolveOpenAIRealtimePlatformAuth(params);
  if (resolved.status === "available") {
    return resolved;
  }
  throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
}

function hasOpenAIRealtimePlatformAuthInput(params: {
  configuredApiKey: string | undefined;
  cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
}): boolean {
  if (hasOpenAIRealtimeConfiguredApiKeyInput(params.configuredApiKey)) {
    return true;
  }
  if (
    isProviderAuthProfileConfigured({
      provider: "openai",
      cfg: params.cfg,
      profileTypes: ["api_key"],
    })
  ) {
    return true;
  }
  return hasOpenAIRealtimeApiKeyInput(undefined);
}

function isOpenAIRealtimeMaxSessionDurationError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("session") &&
    normalized.includes(OPENAI_REALTIME_MAX_SESSION_DURATION_FRAGMENT)
  );
}

function readRealtimeErrorEventId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const eventId = (error as Record<string, unknown>).event_id;
  return typeof eventId === "string" ? eventId : undefined;
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
  readonly supportsToolResultSuppression = true;

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
  private manualResponseCreateEventId: string | null = null;
  private responseCancelInFlight = false;
  private manualResponseCancelEventId: string | null = null;
  private responseCreatePending = false;
  private autoRespondSuppressedForManualResponse = false;
  private continuingToolCallIds = new Set<string>();
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private connectionUrl = "";
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private deliveredToolCallKeys = new Set<string>();
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;
  private reconnectReason: string | undefined;
  private activeConnectionReason: string | undefined;
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

  acknowledgeMark(markName?: string): void {
    const index = markName === undefined ? 0 : this.markQueue.indexOf(markName);
    if (index >= 0) {
      this.markQueue.splice(index, 1);
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
      let settled = false;
      let startupFailureClosing = false;
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
      const connectTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          startupFailureClosing = true;
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
          maxPayload: OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
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
          if (settled && !this.sessionConfigured) {
            return;
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
            if (event.type === "error" && !this.sessionConfigured) {
              rejectStartup(new Error(readRealtimeErrorDetail(event.error)));
              return;
            }
            this.handleEvent(event);
            if (event.type === "session.updated") {
              settleResolve();
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
            rejectStartup(error instanceof Error ? error : new Error(String(error)));
            return;
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
            settleReject(new Error("OpenAI realtime connection closed before ready"));
            return;
          }
          const reason = this.reconnectReason ?? "websocket-close";
          this.reconnectReason = undefined;
          void this.attemptReconnect(reason);
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
    const model = cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL;
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

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
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

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS) {
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
    const delay = OpenAIRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
    this.config.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
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

  private sendSessionUpdate(): void {
    if (this.usesAzureDeploymentRealtimeApi()) {
      this.sendEvent(this.buildAzureDeploymentSessionUpdate());
      return;
    }

    this.sendEvent(this.buildGaSessionUpdate());
  }

  private buildGaSessionUpdate(): RealtimeGaSessionUpdate {
    const cfg = this.config;
    const tools = normalizeOpenAIRealtimeTools(cfg.tools);
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
            noise_reduction: null,
            transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
            turn_detection: this.buildTurnDetectionConfig({ includeInterruptResponse: true }),
          },
          output: {
            format: this.resolveRealtimeAudioFormat(),
            voice: cfg.voice ?? "alloy",
          },
        },
        ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
        ...(tools
          ? {
              tools,
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
    const tools = normalizeOpenAIRealtimeTools(
      cfg.tools,
      AZURE_OPENAI_REALTIME_TOOL_NAME_MAX_LENGTH,
    );
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: cfg.instructions,
        voice: cfg.voice ?? "alloy",
        input_audio_format: format,
        output_audio_format: format,
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: this.buildTurnDetectionConfig(),
        temperature: cfg.temperature ?? 0.8,
        ...(tools
          ? {
              tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };
  }

  private buildTurnDetectionConfig(options?: {
    createResponse?: boolean;
    includeInterruptResponse?: boolean;
  }): RealtimeTurnDetectionConfig {
    const configuredAutoResponse = this.config.autoRespondToAudio ?? true;
    return {
      type: "server_vad",
      threshold: this.config.vadThreshold ?? 0.5,
      prefix_padding_ms: this.config.prefixPaddingMs ?? 300,
      silence_duration_ms: this.config.silenceDurationMs ?? 500,
      create_response: options?.createResponse ?? configuredAutoResponse,
      ...(options?.includeInterruptResponse
        ? {
            interrupt_response: this.config.interruptResponseOnInputAudio ?? configuredAutoResponse,
          }
        : {}),
    };
  }

  private sendAutoResponseSessionUpdate(createResponse: boolean): void {
    const azureDeployment = this.usesAzureDeploymentRealtimeApi();
    const turnDetection = this.buildTurnDetectionConfig({
      createResponse,
      includeInterruptResponse: !azureDeployment,
    });
    if (azureDeployment) {
      this.sendEvent({ type: "session.update", session: { turn_detection: turnDetection } });
      return;
    }
    this.sendEvent({
      type: "session.update",
      session: { type: "realtime", audio: { input: { turn_detection: turnDetection } } },
    });
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
    const emitServerEvent = () =>
      this.config.onEvent?.({
        direction: "server",
        type: event.type,
        detail: this.describeServerEvent(event),
        ...(event.item_id ? { itemId: event.item_id } : {}),
        ...((event.response_id ?? event.response?.id)
          ? { responseId: event.response_id ?? event.response?.id }
          : {}),
      });
    if (
      event.type === "error" &&
      isOpenAIRealtimeMaxSessionDurationError(readRealtimeErrorDetail(event.error))
    ) {
      this.reconnectReason = "max-duration";
      this.activeConnectionReason = "max-duration";
      this.config.onEvent?.({
        direction: "server",
        type: "session.rotation",
        detail: "reason=max-duration",
      });
      this.ws?.close(1000, "max-duration rotation");
      return;
    }
    emitServerEvent();
    switch (event.type) {
      case "session.created":
        return;

      case "session.updated":
        this.sessionConfigured = true;
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
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
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
        this.manualResponseCreateEventId = null;
        this.responseCancelInFlight = false;
        this.manualResponseCancelEventId = null;
        if (this.responseCreatePending) {
          this.flushPendingResponseCreate();
        } else {
          this.restoreAutoRespondAfterManualResponse();
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
        const rejectsManualResponseCreate =
          this.manualResponseCreateEventId !== null &&
          readRealtimeErrorEventId(event.error) === this.manualResponseCreateEventId;
        if (
          rejectsManualResponseCreate &&
          detail.startsWith(OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)
        ) {
          this.responseActive = true;
          this.responseCreateInFlight = false;
          this.manualResponseCreateEventId = null;
          this.responseCreatePending = true;
          return;
        }
        const rejectsManualResponseCancel =
          this.manualResponseCancelEventId !== null &&
          readRealtimeErrorEventId(event.error) === this.manualResponseCancelEventId;
        if (detail === OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
          if (!rejectsManualResponseCancel) {
            return;
          }
          this.responseActive = false;
          this.responseCancelInFlight = false;
          this.manualResponseCancelEventId = null;
          if (this.responseCreatePending) {
            this.flushPendingResponseCreate();
          } else {
            this.restoreAutoRespondAfterManualResponse();
          }
          return;
        }
        if (rejectsManualResponseCreate) {
          this.responseCreateInFlight = false;
          this.manualResponseCreateEventId = null;
          if (this.responseCreatePending) {
            this.flushPendingResponseCreate();
          } else {
            this.restoreAutoRespondAfterManualResponse();
          }
        }
        this.config.onError?.(new Error(detail));
      }

      default:
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
      const eventId = `openclaw-response-cancel-${randomUUID()}`;
      this.manualResponseCancelEventId = eventId;
      this.sendEvent({ type: "response.cancel", event_id: eventId }, "reason=barge-in");
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
      this.config.onClearAudio("barge-in");
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio("barge-in");
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
    this.suppressAutoRespondForManualResponse();
    const eventId = `openclaw-response-create-${randomUUID()}`;
    // Realtime errors can describe unrelated client events. Keep this id until
    // the manual turn settles so only its rejection may release VAD suppression.
    this.manualResponseCreateEventId = eventId;
    this.sendEvent({ type: "response.create", event_id: eventId });
  }

  private suppressAutoRespondForManualResponse(): void {
    if (this.config.autoRespondToAudio === false || this.autoRespondSuppressedForManualResponse) {
      return;
    }
    // Manual response.create owns this turn. Keep VAD events and interruption active,
    // but prevent a second server-owned response until all queued manual work finishes.
    this.autoRespondSuppressedForManualResponse = true;
    this.sendAutoResponseSessionUpdate(false);
  }

  private restoreAutoRespondAfterManualResponse(): void {
    if (!this.autoRespondSuppressedForManualResponse) {
      return;
    }
    this.autoRespondSuppressedForManualResponse = false;
    this.sendAutoResponseSessionUpdate(true);
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
    this.manualResponseCreateEventId = null;
    this.responseCancelInFlight = false;
    this.manualResponseCancelEventId = null;
    this.responseCreatePending = false;
    this.autoRespondSuppressedForManualResponse = false;
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
  if (config.azureEndpoint || config.azureDeployment) {
    throw new Error("OpenAI Realtime browser sessions do not support Azure endpoints yet");
  }

  const model = req.model ?? config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
  if (isOpenAIGptLiveModel(model)) {
    throw new Error(OPENAI_GPT_LIVE_BROWSER_SESSION_UNSUPPORTED_MESSAGE);
  }
  const auth = await requireOpenAIRealtimePlatformAuth({
    configuredApiKey: config.apiKey,
    cfg: req.cfg,
  });
  const voice = normalizeOpenAIRealtimeVoice(req.voice) ?? config.voice ?? "alloy";
  const tools = normalizeOpenAIRealtimeTools(req.tools);
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
  if (tools) {
    session.tools = tools;
    session.tool_choice = "auto";
  }
  const reasoningEffort = trimToUndefined(req.reasoningEffort) ?? config.reasoningEffort;
  if (reasoningEffort) {
    session.reasoning = { effort: reasoningEffort };
  }

  const clientSecret = await createOpenAIRealtimeClientSecret({
    authToken: auth.value,
    auditContext: "openai-realtime-browser-session",
    session,
    authRejectedMessage: OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
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
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ cfg, providerConfig }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.azureEndpoint || config.azureDeployment) {
        return hasOpenAIRealtimeApiKeyInput(config.apiKey);
      }
      return hasOpenAIRealtimePlatformAuthInput({
        configuredApiKey: config.apiKey,
        cfg,
      });
    },
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      if (isOpenAIGptLiveModel(config.model)) {
        throw new Error(OPENAI_GPT_LIVE_BRIDGE_UNSUPPORTED_MESSAGE);
      }
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
