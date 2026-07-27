import {
  isProviderAuthProfileConfigured,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  normalizeOptionalString,
  parseBooleanValue as readBoolean,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";

type XaiRealtimeVoice = "eve" | "ara" | "rex" | "sal" | "leo";
type XaiRealtimeReasoningEffort = "high" | "none";

type XaiRealtimeVoiceProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  reasoningEffort?: XaiRealtimeReasoningEffort;
  sessionResumption?: boolean;
};

export type XaiRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: XaiRealtimeReasoningEffort;
  sessionResumption?: boolean;
  resolveApiKey?: () => Promise<string>;
};

export type XaiRealtimeEvent = {
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
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
  };
  conversation?: { id?: string };
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  error?: unknown;
};

export type XaiRealtimeAudioFormatConfig =
  | { type: "audio/pcm"; rate: 24000 }
  | { type: "audio/pcmu" };

export type XaiRealtimeSessionUpdate = {
  type: "session.update";
  session: {
    instructions?: string;
    voice?: string;
    output_modalities?: string[];
    turn_detection?: {
      type: "server_vad";
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    };
    audio: {
      input: {
        format: XaiRealtimeAudioFormatConfig;
        transcription: { model: string };
      };
      output: { format: XaiRealtimeAudioFormatConfig };
    };
    reasoning?: { effort: XaiRealtimeReasoningEffort };
    resumption?: { enabled: boolean };
    tools?: RealtimeVoiceBridgeCreateRequest["tools"];
    tool_choice?: string;
  };
};

export const XAI_REALTIME_DEFAULT_MODEL = "grok-voice-latest";
export const XAI_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
export const XAI_REALTIME_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const XAI_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
export const XAI_REALTIME_BASE_RECONNECT_DELAY_MS = 1000;
export const XAI_REALTIME_MAX_PENDING_TOOL_RESULTS = 128;
export const XAI_REALTIME_MAX_PENDING_USER_MESSAGES = 128;
export const XAI_REALTIME_DEFAULT_VAD_THRESHOLD = 0.85;
export const XAI_REALTIME_DEFAULT_PREFIX_PADDING_MS = 333;
export const XAI_REALTIME_DEFAULT_SILENCE_DURATION_MS = 500;
export const XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "grok-transcribe";
export const XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
export const XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";

const XAI_REALTIME_VOICES = [
  "eve",
  "ara",
  "rex",
  "sal",
  "leo",
] as const satisfies readonly XaiRealtimeVoice[];

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readNestedXaiConfig(rawConfig: RealtimeVoiceProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.xai ?? raw?.xai ?? raw) ?? {};
}

export function normalizeXaiRealtimeBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

function normalizeXaiRealtimeVoice(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const lower = normalized.toLowerCase();
  return XAI_REALTIME_VOICES.includes(lower as XaiRealtimeVoice)
    ? (lower as XaiRealtimeVoice)
    : normalized;
}

function asXaiVadThreshold(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0.1 && number <= 0.9 ? number : undefined;
}

function asXaiDurationMs(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 && number <= 10_000
    ? number
    : undefined;
}

function asXaiReasoningEffort(value: unknown): XaiRealtimeReasoningEffort | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "high" || normalized === "none") {
    return normalized;
  }
  throw new Error('xAI realtime voice reasoningEffort must be "high" or "none"');
}

export function normalizeXaiRealtimeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): XaiRealtimeVoiceProviderConfig {
  const raw = readNestedXaiConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.xai.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model),
    voice: normalizeXaiRealtimeVoice(raw.speakerVoice ?? raw.voice),
    vadThreshold: asXaiVadThreshold(raw.vadThreshold),
    silenceDurationMs: asXaiDurationMs(raw.silenceDurationMs),
    prefixPaddingMs: asXaiDurationMs(raw.prefixPaddingMs),
    interruptResponseOnInputAudio: readBoolean(raw.interruptResponseOnInputAudio),
    reasoningEffort: asXaiReasoningEffort(raw.reasoningEffort),
    sessionResumption: readBoolean(raw.sessionResumption),
  };
}

export function readXaiRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const record = readRecord(error);
  return (
    normalizeOptionalString(record?.message) ??
    normalizeOptionalString(record?.code) ??
    "xAI realtime voice error"
  );
}

export function toXaiRealtimeWsUrl(
  baseUrl: string,
  model: string,
  conversationId?: string,
): string {
  const url = new URL(normalizeXaiRealtimeBaseUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
  url.searchParams.set("model", model);
  if (conversationId) {
    url.searchParams.set("conversation_id", conversationId);
  }
  return url.toString();
}

export async function resolveXaiRealtimeApiKey(
  configApiKey: string | undefined,
  cfg: OpenClawConfig | undefined,
): Promise<string> {
  const direct =
    normalizeOptionalString(configApiKey) ?? normalizeOptionalString(process.env.XAI_API_KEY);
  if (direct) {
    return direct;
  }
  const auth = await resolveApiKeyForProvider({ provider: "xai", cfg });
  const oauthKey = normalizeOptionalString(auth?.apiKey);
  if (oauthKey) {
    return oauthKey;
  }
  throw new Error(
    "xAI credentials missing for realtime voice. Sign in with `openclaw onboard --auth-choice xai-oauth`, run `openclaw onboard --auth-choice xai-api-key`, or set XAI_API_KEY.",
  );
}

export function hasXaiRealtimeApiKeyInput(
  configApiKey: string | undefined,
  cfg: OpenClawConfig | undefined,
): boolean {
  if (normalizeOptionalString(configApiKey) || normalizeOptionalString(process.env.XAI_API_KEY)) {
    return true;
  }
  return isProviderAuthProfileConfigured({ provider: "xai", cfg });
}
