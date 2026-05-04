import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
  type RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

type MistralRealtimeTranscriptionEncoding =
  | "pcm_s16le"
  | "pcm_s32le"
  | "pcm_f16le"
  | "pcm_f32le"
  | "pcm_mulaw"
  | "pcm_alaw";

type MistralRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  sampleRate?: number;
  encoding?: MistralRealtimeTranscriptionEncoding;
  targetStreamingDelayMs?: number;
};

type MistralRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  model: string;
  sampleRate: number;
  encoding: MistralRealtimeTranscriptionEncoding;
  targetStreamingDelayMs?: number;
};

type MistralRealtimeTranscriptionEvent = {
  type?: string;
  text?: string;
  error?: {
    message?: unknown;
    code?: number;
  };
};

const MISTRAL_REALTIME_DEFAULT_BASE_URL = "wss://api.mistral.ai";
const MISTRAL_REALTIME_DEFAULT_MODEL = "voxtral-mini-transcribe-realtime-2602";
const MISTRAL_REALTIME_DEFAULT_SAMPLE_RATE = 8000;
const MISTRAL_REALTIME_DEFAULT_ENCODING: MistralRealtimeTranscriptionEncoding = "pcm_mulaw";
const MISTRAL_REALTIME_DEFAULT_DELAY_MS = 800;
const MISTRAL_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const MISTRAL_REALTIME_CLOSE_TIMEOUT_MS = 5_000;
const MISTRAL_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
const MISTRAL_REALTIME_RECONNECT_DELAY_MS = 1000;
const MISTRAL_REALTIME_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNestedMistralConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.mistral ?? raw?.mistral ?? raw) ?? {};
}

function readFiniteNumber(value: unknown): number | undefined {
  const next =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : undefined;
  return Number.isFinite(next) ? next : undefined;
}

function normalizeMistralEncoding(
  value: unknown,
): MistralRealtimeTranscriptionEncoding | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  switch (normalized) {
    case "pcm":
    case "linear16":
    case "pcm_s16le":
      return "pcm_s16le";
    case "pcm_s32le":
    case "pcm_f16le":
    case "pcm_f32le":
      return normalized;
    case "mulaw":
    case "ulaw":
    case "g711_ulaw":
    case "g711-mulaw":
    case "pcm_mulaw":
      return "pcm_mulaw";
    case "alaw":
    case "g711_alaw":
    case "g711-alaw":
    case "pcm_alaw":
      return "pcm_alaw";
    default:
      throw new Error(`Invalid Mistral realtime transcription encoding: ${normalized}`);
  }
}

function normalizeMistralRealtimeBaseUrl(value?: string): string {
  const raw = normalizeOptionalString(value ?? process.env.MISTRAL_REALTIME_BASE_URL);
  if (!raw) {
    return MISTRAL_REALTIME_DEFAULT_BASE_URL;
  }
  const url = new URL(raw);
  url.protocol =
    url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function toMistralRealtimeWsUrl(config: MistralRealtimeTranscriptionSessionConfig): string {
  const base = new URL(`${normalizeMistralRealtimeBaseUrl(config.baseUrl)}/`);
  const url = new URL("v1/audio/transcriptions/realtime", base);
  url.searchParams.set("model", config.model);
  if (config.targetStreamingDelayMs != null) {
    url.searchParams.set("target_streaming_delay_ms", String(config.targetStreamingDelayMs));
  }
  return url.toString();
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): MistralRealtimeTranscriptionProviderConfig {
  const raw = readNestedMistralConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.mistral.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model ?? raw.sttModel),
    sampleRate: readFiniteNumber(raw.sampleRate ?? raw.sample_rate),
    encoding: normalizeMistralEncoding(raw.encoding),
    targetStreamingDelayMs: readFiniteNumber(
      raw.targetStreamingDelayMs ?? raw.target_streaming_delay_ms ?? raw.delayMs,
    ),
  };
}

function readErrorDetail(event: MistralRealtimeTranscriptionEvent): string {
  const message = event.error?.message;
  if (typeof message === "string") {
    return message;
  }
  if (message && typeof message === "object") {
    return JSON.stringify(message);
  }
  if (typeof event.error?.code === "number") {
    return `Mistral realtime transcription error (${event.error.code})`;
  }
  return "Mistral realtime transcription error";
}

function createMistralRealtimeTranscriptionSession(
  config: MistralRealtimeTranscriptionSessionConfig,
): RealtimeTranscriptionSession {
  let partialText = "";

  const handleEvent = (
    event: MistralRealtimeTranscriptionEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    if (event.type === "session.created") {
      transport.sendJson({
        type: "session.update",
        session: {
          audio_format: {
            encoding: config.encoding,
            sample_rate: config.sampleRate,
          },
        },
      });
      transport.markReady();
      return;
    }
    if (!transport.isReady() && event.type === "error") {
      transport.failConnect(new Error(readErrorDetail(event)));
      return;
    }
    switch (event.type) {
      case "transcription.text.delta":
        if (event.text) {
          partialText += event.text;
          config.onPartial?.(partialText);
        }
        return;
      case "transcription.segment":
        if (event.text) {
          config.onTranscript?.(event.text);
          partialText = "";
        }
        return;
      case "transcription.done":
        if (partialText.trim()) {
          config.onTranscript?.(partialText);
          partialText = "";
        }
        transport.closeNow();
        return;
      case "error":
        config.onError?.(new Error(readErrorDetail(event)));
        return;
      default:
        return;
    }
  };

  return createRealtimeTranscriptionWebSocketSession<MistralRealtimeTranscriptionEvent>({
    providerId: "mistral",
    callbacks: config,
    url: () => toMistralRealtimeWsUrl(config),
    headers: { Authorization: `Bearer ${config.apiKey}` },
    connectTimeoutMs: MISTRAL_REALTIME_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: MISTRAL_REALTIME_CLOSE_TIMEOUT_MS,
    maxReconnectAttempts: MISTRAL_REALTIME_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: MISTRAL_REALTIME_RECONNECT_DELAY_MS,
    maxQueuedBytes: MISTRAL_REALTIME_MAX_QUEUED_BYTES,
    connectTimeoutMessage: "Mistral realtime transcription connection timeout",
    reconnectLimitMessage: "Mistral realtime transcription reconnect limit reached",
    sendAudio: (audio, transport) => {
      transport.sendJson({
        type: "input_audio.append",
        audio: audio.toString("base64"),
      });
    },
    onClose: (transport) => {
      transport.sendJson({ type: "input_audio.flush" });
      transport.sendJson({ type: "input_audio.end" });
    },
    onMessage: handleEvent,
  });
}

export function buildMistralRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "mistral",
    label: "Mistral Realtime Transcription",
    aliases: ["mistral-realtime", "voxtral-realtime"],
    defaultModel: MISTRAL_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 45,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.MISTRAL_API_KEY),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.MISTRAL_API_KEY;
      if (!apiKey) {
        throw new Error("Mistral API key missing");
      }
      return createMistralRealtimeTranscriptionSession({
        ...req,
        apiKey,
        baseUrl: normalizeMistralRealtimeBaseUrl(config.baseUrl),
        model: config.model ?? MISTRAL_REALTIME_DEFAULT_MODEL,
        sampleRate: config.sampleRate ?? MISTRAL_REALTIME_DEFAULT_SAMPLE_RATE,
        encoding: config.encoding ?? MISTRAL_REALTIME_DEFAULT_ENCODING,
        targetStreamingDelayMs: config.targetStreamingDelayMs ?? MISTRAL_REALTIME_DEFAULT_DELAY_MS,
      });
    },
  };
}

export const __testing = {
  normalizeProviderConfig,
  toMistralRealtimeWsUrl,
};
