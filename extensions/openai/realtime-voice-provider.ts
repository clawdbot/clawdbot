// Openai provider module implements model/runtime integration.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
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
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  RealtimeVoiceSessionLifecycle,
} from "openclaw/plugin-sdk/realtime-voice";
import { sleepWithAbort, warn } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket from "ws";
import {
  asFiniteNumber,
  captureOpenAIRealtimeWsClose,
  createOpenAIRealtimeClientSecret,
  readRealtimeErrorDetail,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { buildOpenAIQuicksilverInstructions } from "./realtime-quicksilver-instructions.js";
import {
  createOpenAIQuicksilverBrowserSessionBroker,
  OPENAI_QUICKSILVER_CAPABILITIES,
  resolveOpenAIChatGptSubscriptionAuth,
} from "./realtime-quicksilver-session.js";
import {
  isOpenAIGptLiveModel,
  isSupportedOpenAIGptLiveModel,
  OPENAI_GPT_LIVE_MODELS,
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
// Picker suggestions surfaced through talk.catalog; each value is live-verified
// against the OpenAI realtime APIs. Free-form model values are still accepted.
const OPENAI_REALTIME_MODELS = [
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-2",
  ...OPENAI_GPT_LIVE_MODELS,
] as const;
const OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_CAPABILITIES: RealtimeVoiceProviderCapabilities = {
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
  supportsVideoFrames: true,
};
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
    output?: unknown[];
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
        transcription?: { model: string; language?: string };
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
    input_audio_transcription?: { model: string; language?: string };
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
const OPENAI_GPT_LIVE_AUTH_REQUIRED =
  "GPT-Live Talk requires either an OpenAI Platform API key or a ChatGPT OAuth subscription profile";
const OPENAI_GPT_LIVE_AUTHORED_PLATFORM_AUTH_UNAVAILABLE =
  "GPT-Live Talk requires a working OpenAI Platform API key or ChatGPT OAuth subscription profile. The selected Platform API-key source could not be resolved, so OAuth fallback was not used; fix or remove it.";
const OPENAI_REALTIME_API_KEY_REQUIRED = "OpenAI Realtime voice requires an API key";
const OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED =
  "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source";
const KEYCHAIN_SECRET_REF_RE = /^keychain:([^:]+):([^:]+)$/;
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 5000;
const resolvedKeychainSecretRefCache = new Map<string, string>();

function isDirectOpenAIRealtimeWebSocketUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function isOpenAIRealtimeStartupAuthFailure(error: unknown): boolean {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const status = record?.status ?? record?.statusCode;
  const rawCode = record?.code ?? record?.errorCode;
  const code = typeof rawCode === "string" ? rawCode.toLowerCase() : "";
  const message = readRealtimeErrorDetail(error).toLowerCase();
  return (
    status === 401 ||
    code === "invalid_api_key" ||
    message.includes("invalid_api_key") ||
    message.includes("incorrect api key provided") ||
    message.includes("unexpected server response: 401")
  );
}

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
    includeExternalCliAuth: false,
  });
  if (profileApiKey) {
    return { status: "available", value: profileApiKey };
  }
  const hasConfiguredApiKeyProfile = isProviderAuthProfileConfigured({
    provider: "openai",
    cfg: params.cfg,
    profileTypes: ["api_key"],
    includeExternalCliAuth: false,
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

async function resolveOpenAIQuicksilverBridgeAuth(params: {
  configuredApiKey: string | undefined;
  cfg: RealtimeVoiceBridgeCreateRequest["cfg"] | undefined;
  agentId?: string;
}) {
  const subscriptionAuth = await resolveOpenAIChatGptSubscriptionAuth({
    cfg: params.cfg,
    agentDir:
      params.cfg && params.agentId ? resolveAgentDir(params.cfg, params.agentId) : undefined,
  });
  if (subscriptionAuth) {
    return subscriptionAuth;
  }
  const platformAuth = await resolveOpenAIRealtimePlatformAuth(params);
  if (platformAuth.status === "available") {
    return { type: "api-key" as const, token: platformAuth.value };
  }
  if (
    hasOpenAIRealtimePlatformAuthInput({
      configuredApiKey: params.configuredApiKey,
      cfg: params.cfg,
    })
  ) {
    throw new Error(OPENAI_GPT_LIVE_AUTHORED_PLATFORM_AUTH_UNAVAILABLE);
  }
  throw new Error(OPENAI_GPT_LIVE_AUTH_REQUIRED);
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
      includeExternalCliAuth: false,
    })
  ) {
    return true;
  }
  return hasOpenAIRealtimeApiKeyInput(undefined);
}

function hasOpenAIChatGptSubscriptionAuthInput(params: {
  cfg: RealtimeVoiceBrowserSessionCreateRequest["cfg"] | undefined;
  agentId?: string;
}): boolean {
  return isProviderAuthProfileConfigured({
    provider: "openai",
    cfg: params.cfg,
    agentDir:
      params.cfg && params.agentId ? resolveAgentDir(params.cfg, params.agentId) : undefined,
    profileTypes: ["oauth"],
    includeExternalCliAuth: false,
  });
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

function parsePlaybackMarkSequence(markName: string): number | undefined {
  const match = /^audio-(\d+)$/u.exec(markName);
  if (!match) {
    return undefined;
  }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}

class OpenAIRealtimeMalformedAudioError extends Error {}

function base64ToBuffer(b64: string): Buffer {
  const canonicalAudio = canonicalizeBase64(b64);
  if (!canonicalAudio) {
    throw new OpenAIRealtimeMalformedAudioError(
      "OpenAI realtime stream returned malformed base64 audio data",
    );
  }
  return Buffer.from(canonicalAudio, "base64");
}

class OpenAIRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = OPENAI_REALTIME_DEFAULT_MODEL;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;
  private static readonly MAX_TOOL_ARGUMENT_BYTES = 256_000;
  // Realtime defines no replay window. Keep every terminal id for this
  // connection generation, then fail instead of re-admitting late duplicates.
  private static readonly MAX_COMPLETED_TOOL_CALL_IDS = 1_024;
  readonly supportsToolResultContinuation = true;
  readonly supportsToolResultSuppression = true;

  private ws: WebSocket | null = null;
  private readonly lifecycle = new RealtimeVoiceSessionLifecycle("OpenAI");
  private nextMarkSequence = 1;
  private oldestOutstandingMarkSequence: number | null = null;
  private latestOutstandingMarkSequence: number | null = null;
  private responseStartTimestamp: number | null = null;
  private responseActive = false;
  private responseCreateInFlight = false;
  private manualResponseCreateEventId: string | null = null;
  private responseCancelInFlight = false;
  private manualResponseCancelEventId: string | null = null;
  private responseCreatePending = false;
  private autoRespondSuppressedForManualResponse = false;
  private continuingToolCallIds = new Set<string>();
  private pendingToolCallIds = new Set<string>();
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private connectionUrl = "";
  private completedToolCallIds = new Set<string>();
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;
  private reconnectReason: string | undefined;
  private activeConnectionReason: string | undefined;
  private terminalError: Error | undefined;
  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(private readonly config: OpenAIRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
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
    if (this.lifecycle.phase() === "terminal" || !this.pendingToolCallIds.has(callId)) {
      return;
    }
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
    this.pendingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      this.flushPendingResponseCreate();
      return;
    }
    this.requestResponseCreate();
  }

  acknowledgeMark(markName?: string): void {
    const oldest = this.oldestOutstandingMarkSequence;
    const latest = this.latestOutstandingMarkSequence;
    if (oldest === null || latest === null) {
      return;
    }
    const acknowledgedSequence =
      markName === undefined ? oldest : parsePlaybackMarkSequence(markName);
    if (
      acknowledgedSequence === undefined ||
      acknowledgedSequence < oldest ||
      acknowledgedSequence > latest
    ) {
      return;
    }
    // Marks follow ordered playback. Reaching a named mark also acknowledges every
    // earlier mark, while late acknowledgements from that prefix remain harmless.
    if (acknowledgedSequence === latest) {
      this.oldestOutstandingMarkSequence = null;
      this.latestOutstandingMarkSequence = null;
      return;
    }
    this.oldestOutstandingMarkSequence = acknowledgedSequence + 1;
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
    const attempt = this.lifecycle.createConnectAttempt({
      connection: lifecycleConnection,
      timeoutMs: OpenAIRealtimeVoiceBridge.CONNECT_TIMEOUT_MS,
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
              const readyError = error instanceof Error ? error : new Error(String(error));
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
          errorText: error instanceof Error ? error.message : String(error),
          meta: {
            provider: "openai",
            capability: "realtime-voice",
          },
        });
        if (!attempt.ready) {
          const startupError = error instanceof Error ? error : new Error(String(error));
          rejectStartup(
            isDirectOpenAIRealtimeWebSocketUrl(url) &&
              isOpenAIRealtimeStartupAuthFailure(startupError)
              ? new Error(OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED)
              : startupError,
          );
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
      attempt.reject(error instanceof Error ? error : new Error(String(error)));
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
        attempt.reject(error instanceof Error ? error : new Error(String(error)));
      });
    } else {
      try {
        openWebSocket(connectionOrPromise);
      } catch (error) {
        attempt.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    await attempt.promise;
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

  private async attemptReconnect(
    reason: string,
    connection: RealtimeVoiceSessionConnection,
  ): Promise<void> {
    const retry = this.lifecycle.retry(
      connection,
      OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS,
    );
    if (!retry) {
      return;
    }
    if (retry === "exhausted") {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS}`,
      });
      if (this.lifecycle.failure(connection)) {
        this.resetTerminalState();
      }
      this.notifyClose(connection, "error");
      return;
    }
    const attempt = retry.attempt;
    const delay = OpenAIRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
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
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason, nextConnection);
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
            transcription: {
              model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL,
              ...(cfg.language ? { language: cfg.language } : {}),
            },
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
        input_audio_transcription: {
          model: "whisper-1",
          ...(cfg.language ? { language: cfg.language } : {}),
        },
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

  private handleEvent(event: RealtimeEvent, connection: RealtimeVoiceSessionConnection): void {
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

      case "session.updated": {
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
        return;
      }

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
      case "response.text.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.text.done":
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

      case "conversation.item.input_audio_transcription.failed":
        this.config.onError?.(new Error(readRealtimeErrorDetail(event.error)));
        break;

      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
      case "conversation.item.done":
        // These events are provisional and can also arrive for interrupted,
        // incomplete, or cancelled responses. Successful response.done output
        // is the sole execution boundary.
        return;

      case "response.cancelled":
      case "response.done":
        if (this.handleCompletedResponse(event, connection)) {
          return;
        }
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
        (this.oldestOutstandingMarkSequence !== null || options?.audioPlaybackActive === true)) ||
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
      this.clearOutstandingMarks();
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio("barge-in");
  }

  private handleCompletedResponse(
    event: RealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
  ): boolean {
    if (
      event.type !== "response.done" ||
      event.response?.status !== "completed" ||
      !Array.isArray(event.response.output) ||
      !this.config.onToolCall
    ) {
      return false;
    }
    for (const output of event.response.output) {
      if (!this.lifecycle.acceptsEvents(connection) || this.ws?.readyState !== WebSocket.OPEN) {
        return true;
      }
      if (
        !isRecord(output) ||
        output.type !== "function_call" ||
        (output.status !== undefined && output.status !== "completed")
      ) {
        continue;
      }
      const itemId = typeof output.id === "string" ? output.id.trim() || undefined : undefined;
      const callId = typeof output.call_id === "string" ? output.call_id.trim() : "";
      const name = typeof output.name === "string" ? output.name.trim() : "";
      if (!callId || !name || this.completedToolCallIds.has(callId)) {
        continue;
      }
      if (this.completedToolCallIds.size >= OpenAIRealtimeVoiceBridge.MAX_COMPLETED_TOOL_CALL_IDS) {
        const ws = this.ws;
        if (ws) {
          this.failConnection(
            new Error(
              `OpenAI realtime tool-call session limit exceeded (${OpenAIRealtimeVoiceBridge.MAX_COMPLETED_TOOL_CALL_IDS})`,
            ),
            ws,
            connection,
            { code: 1008, reason: "Tool-call session limit exceeded" },
          );
        }
        return true;
      }
      this.completedToolCallIds.add(callId);
      this.pendingToolCallIds.add(callId);
      if (typeof output.arguments !== "string") {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "invalid-json-type",
          message: "Invalid tool arguments: expected a JSON object.",
        });
        continue;
      }
      const rawArgs = output.arguments;
      if (Buffer.byteLength(rawArgs, "utf8") > OpenAIRealtimeVoiceBridge.MAX_TOOL_ARGUMENT_BYTES) {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "too-large",
          message: `Realtime tool arguments exceed the ${OpenAIRealtimeVoiceBridge.MAX_TOOL_ARGUMENT_BYTES}-byte UTF-8 limit`,
        });
        continue;
      }
      let args: unknown;
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "malformed-json",
          message: "Invalid tool arguments: expected a JSON object.",
        });
        continue;
      }
      if (!isRecord(args)) {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "non-object-json",
          message: "Invalid tool arguments: expected a JSON object.",
        });
        continue;
      }
      this.config.onToolCall({ itemId: itemId ?? callId, callId, name, args });
    }
    return false;
  }

  private rejectToolCallArguments(params: {
    itemId?: string;
    callId: string;
    reason: string;
    message: string;
  }): void {
    this.config.onEvent?.({
      direction: "server",
      type: "tool_call.arguments.rejected",
      detail: `reason=${params.reason}`,
      itemId: params.itemId,
    });
    this.submitToolResult(params.callId, { error: params.message });
  }

  private requestResponseCreate(): void {
    if (
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.continuingToolCallIds.size > 0 ||
      this.pendingToolCallIds.size > 0
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
    this.clearOutstandingMarks();
    this.responseStartTimestamp = null;
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.manualResponseCreateEventId = null;
    this.responseCancelInFlight = false;
    this.manualResponseCancelEventId = null;
    this.responseCreatePending = false;
    this.autoRespondSuppressedForManualResponse = false;
    this.continuingToolCallIds.clear();
    this.pendingToolCallIds.clear();
    this.lastAssistantItemId = null;
    this.completedToolCallIds.clear();
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

  private sendMark(): void {
    const sequence = this.nextMarkSequence;
    this.nextMarkSequence += 1;
    if (this.oldestOutstandingMarkSequence === null) {
      this.oldestOutstandingMarkSequence = sequence;
    }
    this.latestOutstandingMarkSequence = sequence;
    const markName = `audio-${sequence}`;
    this.config.onMark?.(markName);
  }

  private clearOutstandingMarks(): void {
    this.oldestOutstandingMarkSequence = null;
    this.latestOutstandingMarkSequence = null;
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
    if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
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

type OpenAIQuicksilverBrowserSessionBroker = ReturnType<
  typeof createOpenAIQuicksilverBrowserSessionBroker
>["broker"];

type OpenAIInternalRealtimeBrowserSessionCreateRequest =
  RealtimeVoiceBrowserSessionCreateRequest & {
    agentId: string;
    workspaceDir: string;
    initialItems: Array<{
      role: "user" | "assistant";
      text: string;
    }>;
  };

type OpenAIInternalRealtimeVoiceCapabilities = RealtimeVoiceProviderCapabilities & {
  handlesAgentConsult?: boolean;
};

type OpenAIInternalRealtimeVoiceProviderApi = {
  isBrowserSessionConfigured: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
  }) => boolean;
  resolveBrowserSessionCapabilities?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    model?: string;
  }) => OpenAIInternalRealtimeVoiceCapabilities;
  isGatewayRelayConfigured?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
  }) => boolean | undefined;
  resolveGatewayRelayCapabilities?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    model?: string;
  }) => OpenAIInternalRealtimeVoiceCapabilities;
  validateGatewayRelayLaunch?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    model?: string;
    autoRespondToAudio?: boolean;
  }) => string | undefined;
  cancelBrowserSession?: (
    request: OpenAIInternalRealtimeBrowserSessionCreateRequest,
    session: RealtimeVoiceBrowserSession,
  ) => Promise<void> | void;
};

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

const quicksilverBrokerBySession = new WeakMap<
  RealtimeVoiceBrowserSession,
  OpenAIQuicksilverBrowserSessionBroker
>();

async function createOpenAIRealtimeBrowserSession(
  req: OpenAIInternalRealtimeBrowserSessionCreateRequest,
  quicksilverBroker: OpenAIQuicksilverBrowserSessionBroker | undefined,
): Promise<RealtimeVoiceBrowserSession> {
  const rawConfig = resolveOpenAIProviderConfigRecord(req.providerConfig);
  const config = normalizeProviderConfig(req.providerConfig);
  if (config.azureEndpoint || config.azureDeployment) {
    throw new Error("OpenAI Realtime browser sessions do not support Azure endpoints yet");
  }

  const model = req.model ?? config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
  if (isOpenAIGptLiveModel(model)) {
    if (!quicksilverBroker) {
      throw new Error("OpenAI GPT-Live browser session broker is unavailable");
    }
    const configuredVoice = trimToUndefined(rawConfig?.speakerVoice ?? rawConfig?.voice);
    const quicksilverRequest = {
      ...req,
      model,
      instructions: buildOpenAIQuicksilverInstructions(req.instructions),
      ...(req.voice ? {} : configuredVoice ? { voice: configuredVoice } : {}),
    };
    const subscriptionAuth = await resolveOpenAIChatGptSubscriptionAuth({
      cfg: req.cfg,
      agentDir: req.cfg ? resolveAgentDir(req.cfg, req.agentId) : undefined,
    });
    if (subscriptionAuth) {
      const session = await quicksilverBroker.createBrowserSession(
        quicksilverRequest,
        subscriptionAuth,
      );
      quicksilverBrokerBySession.set(session, quicksilverBroker);
      return session;
    }
    const auth = await resolveOpenAIRealtimePlatformAuth({
      configuredApiKey: config.apiKey,
      cfg: req.cfg,
    });
    if (auth.status === "available") {
      const session = await quicksilverBroker.createBrowserSession(quicksilverRequest, {
        type: "api-key",
        token: auth.value,
      });
      quicksilverBrokerBySession.set(session, quicksilverBroker);
      return session;
    }
    if (
      hasOpenAIRealtimePlatformAuthInput({
        configuredApiKey: config.apiKey,
        cfg: req.cfg,
      })
    ) {
      throw new Error(OPENAI_GPT_LIVE_AUTHORED_PLATFORM_AUTH_UNAVAILABLE);
    }
    throw new Error(OPENAI_GPT_LIVE_AUTH_REQUIRED);
  }
  const auth = await resolveOpenAIRealtimePlatformAuth({
    configuredApiKey: config.apiKey,
    cfg: req.cfg,
  });
  if (auth.status === "missing") {
    if (
      hasOpenAIRealtimePlatformAuthInput({
        configuredApiKey: config.apiKey,
        cfg: req.cfg,
      })
    ) {
      throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
    }
    const subscriptionAuth = await resolveOpenAIChatGptSubscriptionAuth({
      cfg: req.cfg,
      agentDir: req.cfg ? resolveAgentDir(req.cfg, req.agentId) : undefined,
    });
    if (!subscriptionAuth) {
      throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
    }
    if (!quicksilverBroker) {
      throw new Error("OpenAI realtime browser session broker is unavailable");
    }
    const session = await quicksilverBroker.createBrowserSession(
      {
        ...req,
        model,
        voice: normalizeOpenAIRealtimeVoice(req.voice) ?? config.voice ?? "alloy",
      },
      subscriptionAuth,
    );
    quicksilverBrokerBySession.set(session, quicksilverBroker);
    return session;
  }

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

async function cancelOpenAIRealtimeBrowserSession(
  _req: OpenAIInternalRealtimeBrowserSessionCreateRequest,
  session: RealtimeVoiceBrowserSession,
): Promise<void> {
  const quicksilverBroker = quicksilverBrokerBySession.get(session);
  quicksilverBrokerBySession.delete(session);
  quicksilverBroker?.cancelBrowserSession(session);
}

export function buildOpenAIRealtimeVoiceProvider(options?: {
  quicksilverBrowserSessionBroker?: OpenAIQuicksilverBrowserSessionBroker;
  logger?: Pick<PluginLogger, "debug" | "warn">;
}): RealtimeVoiceProviderPlugin {
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI Realtime Voice",
    defaultModel: OPENAI_REALTIME_DEFAULT_MODEL,
    // GA and GPT-Live accept the same ten voices; quicksilver validates at call
    // creation because voice is immutable once the session starts.
    models: OPENAI_REALTIME_MODELS,
    voices: OPENAI_REALTIME_VOICES,
    autoSelectOrder: 10,
    capabilities: OPENAI_REALTIME_CAPABILITIES,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ cfg, providerConfig }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.azureEndpoint || config.azureDeployment) {
        return hasOpenAIRealtimeApiKeyInput(config.apiKey);
      }
      if (
        hasOpenAIRealtimePlatformAuthInput({
          configuredApiKey: config.apiKey,
          cfg,
        })
      ) {
        return true;
      }
      return false;
    },
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const model = config.model;
      if (model && isOpenAIGptLiveModel(model)) {
        if (config.azureEndpoint || config.azureDeployment) {
          throw new Error(
            "GPT-Live backend WebSocket sessions do not support Azure endpoints or deployments",
          );
        }
        if (req.runAgentConsult) {
          return new OpenAIQuicksilverGatewayBridge({
            ...req,
            model,
            voice: config.voice ?? "marin",
            instructions: buildOpenAIQuicksilverInstructions(req.instructions),
            logger: options?.logger ?? { debug: () => undefined, warn: () => undefined },
            resolveAuth: () =>
              resolveOpenAIQuicksilverBridgeAuth({
                configuredApiKey: config.apiKey,
                cfg: req.cfg,
                agentId: req.agentId,
              }),
          });
        }
        return new OpenAIQuicksilverVoiceBridge({
          ...req,
          model,
          voice: config.voice,
          instructions: buildOpenAIQuicksilverInstructions(req.instructions),
          resolveAuth: async () => ({
            type: "api-key",
            token: (
              await requireOpenAIRealtimePlatformAuth({
                configuredApiKey: config.apiKey,
                cfg: req.cfg,
              })
            ).value,
          }),
        });
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
    createBrowserSession: (req) =>
      createOpenAIRealtimeBrowserSession(
        req as OpenAIInternalRealtimeBrowserSessionCreateRequest,
        options?.quicksilverBrowserSessionBroker,
      ),
  };
  const internalApi: OpenAIInternalRealtimeVoiceProviderApi = {
    isBrowserSessionConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.azureEndpoint || config.azureDeployment) {
        return false;
      }
      const model = config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
      if (isOpenAIGptLiveModel(model)) {
        if (!isSupportedOpenAIGptLiveModel(model)) {
          return false;
        }
        return (
          options?.quicksilverBrowserSessionBroker !== undefined &&
          (hasOpenAIRealtimePlatformAuthInput({
            configuredApiKey: config.apiKey,
            cfg,
          }) ||
            hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }))
        );
      }
      return (
        hasOpenAIRealtimePlatformAuthInput({
          configuredApiKey: config.apiKey,
          cfg,
        }) ||
        (options?.quicksilverBrowserSessionBroker !== undefined &&
          hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }))
      );
    },
    resolveBrowserSessionCapabilities: ({ providerConfig, model }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (isSupportedOpenAIGptLiveModel(model ?? config.model)) {
        return {
          ...OPENAI_REALTIME_CAPABILITIES,
          ...OPENAI_QUICKSILVER_CAPABILITIES,
        };
      }
      return OPENAI_REALTIME_CAPABILITIES;
    },
    isGatewayRelayConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (!isOpenAIGptLiveModel(config.model)) {
        return undefined;
      }
      if (config.azureEndpoint || config.azureDeployment) {
        return false;
      }
      return (
        isSupportedOpenAIGptLiveModel(config.model) &&
        (hasOpenAIRealtimePlatformAuthInput({
          configuredApiKey: config.apiKey,
          cfg,
        }) ||
          hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }))
      );
    },
    resolveGatewayRelayCapabilities: ({ providerConfig, model }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (isSupportedOpenAIGptLiveModel(model ?? config.model)) {
        return {
          ...OPENAI_REALTIME_CAPABILITIES,
          ...OPENAI_QUICKSILVER_CAPABILITIES,
        };
      }
      return OPENAI_REALTIME_CAPABILITIES;
    },
    validateGatewayRelayLaunch: ({ providerConfig, model, autoRespondToAudio }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (autoRespondToAudio === false && isOpenAIGptLiveModel(model ?? config.model)) {
        return "GPT-Live gateway-relay sessions cannot use forced agent consult routing; GPT-Live delegates to the agent natively";
      }
      return undefined;
    },
    cancelBrowserSession: cancelOpenAIRealtimeBrowserSession,
  };
  Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
    configurable: true,
    value: internalApi,
  });
  return provider;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
