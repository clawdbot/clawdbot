import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_DEEPGRAM_AUDIO_BASE_URL, DEFAULT_DEEPGRAM_AUDIO_MODEL } from "./audio.js";

type DeepgramRealtimeTranscriptionEncoding = "linear16" | "mulaw" | "alaw";

type DeepgramRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  encoding?: DeepgramRealtimeTranscriptionEncoding;
  interimResults?: boolean;
  endpointingMs?: number;
};

type DeepgramRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  model: string;
  sampleRate: number;
  encoding: DeepgramRealtimeTranscriptionEncoding;
  interimResults: boolean;
  endpointingMs: number;
  language?: string;
};

type DeepgramRealtimeTranscriptionEvent = {
  type?: string;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
  error?: unknown;
  message?: string;
};

const DEEPGRAM_REALTIME_DEFAULT_SAMPLE_RATE = 8000;
const DEEPGRAM_REALTIME_DEFAULT_ENCODING: DeepgramRealtimeTranscriptionEncoding = "mulaw";
const DEEPGRAM_REALTIME_DEFAULT_ENDPOINTING_MS = 800;
const DEEPGRAM_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const DEEPGRAM_REALTIME_CLOSE_TIMEOUT_MS = 5_000;
const DEEPGRAM_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
const DEEPGRAM_REALTIME_RECONNECT_DELAY_MS = 1000;
const DEEPGRAM_REALTIME_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNestedDeepgramConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.deepgram ?? raw?.deepgram ?? raw) ?? {};
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

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeDeepgramEncoding(
  value: unknown,
): DeepgramRealtimeTranscriptionEncoding | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "pcm" || normalized === "pcm_s16le" || normalized === "linear16") {
    return "linear16";
  }
  if (normalized === "ulaw" || normalized === "g711_ulaw" || normalized === "g711-mulaw") {
    return "mulaw";
  }
  if (normalized === "g711_alaw" || normalized === "g711-alaw") {
    return "alaw";
  }
  if (normalized === "mulaw" || normalized === "alaw") {
    return normalized;
  }
  throw new Error(`Invalid Deepgram realtime transcription encoding: ${normalized}`);
}

function normalizeDeepgramRealtimeBaseUrl(value?: string): string {
  return (
    normalizeOptionalString(value ?? process.env.DEEPGRAM_BASE_URL) ??
    DEFAULT_DEEPGRAM_AUDIO_BASE_URL
  );
}

function toDeepgramRealtimeWsUrl(config: DeepgramRealtimeTranscriptionSessionConfig): string {
  const url = new URL(normalizeDeepgramRealtimeBaseUrl(config.baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/listen`;
  url.searchParams.set("model", config.model);
  url.searchParams.set("encoding", config.encoding);
  url.searchParams.set("sample_rate", String(config.sampleRate));
  url.searchParams.set("channels", "1");
  url.searchParams.set("interim_results", String(config.interimResults));
  url.searchParams.set("endpointing", String(config.endpointingMs));
  if (config.language) {
    url.searchParams.set("language", config.language);
  }
  return url.toString();
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): DeepgramRealtimeTranscriptionProviderConfig {
  const raw = readNestedDeepgramConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.deepgram.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model ?? raw.sttModel),
    language: normalizeOptionalString(raw.language),
    sampleRate: readFiniteNumber(raw.sampleRate ?? raw.sample_rate),
    encoding: normalizeDeepgramEncoding(raw.encoding),
    interimResults: readBoolean(raw.interimResults ?? raw.interim_results),
    endpointingMs: readFiniteNumber(raw.endpointingMs ?? raw.endpointing ?? raw.silenceDurationMs),
  };
}

function readErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  const message = normalizeOptionalString(record?.message);
  const code = normalizeOptionalString(record?.code);
  return message ?? code ?? "Deepgram realtime transcription error";
}

function readTranscriptText(event: DeepgramRealtimeTranscriptionEvent): string | undefined {
  return normalizeOptionalString(event.channel?.alternatives?.[0]?.transcript);
}

function createDeepgramRealtimeTranscriptionSession(
  config: DeepgramRealtimeTranscriptionSessionConfig,
): RealtimeTranscriptionSession {
  let lastTranscript: string | undefined;
  let speechStarted = false;

  const emitTranscript = (text: string) => {
    if (text === lastTranscript) {
      return;
    }
    lastTranscript = text;
    config.onTranscript?.(text);
  };

  const handleEvent = (event: DeepgramRealtimeTranscriptionEvent) => {
    switch (event.type) {
      case "Results": {
        const text = readTranscriptText(event);
        if (!text) {
          return;
        }
        if (!speechStarted) {
          speechStarted = true;
          config.onSpeechStart?.();
        }
        if (event.is_final || event.speech_final) {
          emitTranscript(text);
          if (event.speech_final) {
            speechStarted = false;
          }
          return;
        }
        config.onPartial?.(text);
        return;
      }
      case "SpeechStarted":
        speechStarted = true;
        config.onSpeechStart?.();
        return;
      case "Error":
      case "error":
        config.onError?.(new Error(readErrorDetail(event.error ?? event.message)));
        return;
      default:
        return;
    }
  };

  return createRealtimeTranscriptionWebSocketSession<DeepgramRealtimeTranscriptionEvent>({
    providerId: "deepgram",
    callbacks: config,
    url: () => toDeepgramRealtimeWsUrl(config),
    headers: { Authorization: `Token ${config.apiKey}` },
    readyOnOpen: true,
    connectTimeoutMs: DEEPGRAM_REALTIME_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: DEEPGRAM_REALTIME_CLOSE_TIMEOUT_MS,
    maxReconnectAttempts: DEEPGRAM_REALTIME_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: DEEPGRAM_REALTIME_RECONNECT_DELAY_MS,
    maxQueuedBytes: DEEPGRAM_REALTIME_MAX_QUEUED_BYTES,
    connectTimeoutMessage: "Deepgram realtime transcription connection timeout",
    connectClosedBeforeReadyMessage:
      "Deepgram realtime transcription connection closed before ready",
    reconnectLimitMessage: "Deepgram realtime transcription reconnect limit reached",
    sendAudio: (audio, transport) => {
      transport.sendBinary(audio);
    },
    onClose: (transport) => {
      transport.sendJson({ type: "Finalize" });
    },
    onMessage: handleEvent,
  });
}

export function buildDeepgramRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "deepgram",
    label: "Deepgram Realtime Transcription",
    aliases: ["deepgram-realtime", "nova-3-streaming"],
    defaultModel: DEFAULT_DEEPGRAM_AUDIO_MODEL,
    autoSelectOrder: 35,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.DEEPGRAM_API_KEY),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        throw new Error("Deepgram API key missing");
      }
      return createDeepgramRealtimeTranscriptionSession({
        ...req,
        apiKey,
        baseUrl: normalizeDeepgramRealtimeBaseUrl(config.baseUrl),
        model: config.model ?? DEFAULT_DEEPGRAM_AUDIO_MODEL,
        sampleRate: config.sampleRate ?? DEEPGRAM_REALTIME_DEFAULT_SAMPLE_RATE,
        encoding: config.encoding ?? DEEPGRAM_REALTIME_DEFAULT_ENCODING,
        interimResults: config.interimResults ?? true,
        endpointingMs: config.endpointingMs ?? DEEPGRAM_REALTIME_DEFAULT_ENDPOINTING_MS,
        language: config.language,
      });
    },
  };
}

export const __testing = {
  normalizeProviderConfig,
  toDeepgramRealtimeWsUrl,
};
