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
import { XAI_BASE_URL } from "./model-definitions.js";

type XaiRealtimeTranscriptionEncoding = "pcm" | "mulaw" | "alaw";

type XaiRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  sampleRate?: number;
  encoding?: XaiRealtimeTranscriptionEncoding;
  interimResults?: boolean;
  endpointingMs?: number;
  language?: string;
};

type XaiRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  sampleRate: number;
  encoding: XaiRealtimeTranscriptionEncoding;
  interimResults: boolean;
  endpointingMs: number;
  language?: string;
};

type XaiRealtimeTranscriptionEvent = {
  type?: string;
  text?: string;
  transcript?: string;
  is_final?: boolean;
  speech_final?: boolean;
  error?: unknown;
  message?: string;
};

const XAI_REALTIME_STT_DEFAULT_SAMPLE_RATE = 8000;
const XAI_REALTIME_STT_DEFAULT_ENCODING: XaiRealtimeTranscriptionEncoding = "mulaw";
const XAI_REALTIME_STT_DEFAULT_ENDPOINTING_MS = 800;
const XAI_REALTIME_STT_CONNECT_TIMEOUT_MS = 10_000;
const XAI_REALTIME_STT_CLOSE_TIMEOUT_MS = 5_000;
const XAI_REALTIME_STT_MAX_RECONNECT_ATTEMPTS = 5;
const XAI_REALTIME_STT_RECONNECT_DELAY_MS = 1000;
const XAI_REALTIME_STT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readNestedXaiConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.xai ?? raw?.xai ?? raw) ?? {};
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

function normalizeEncoding(value: unknown): XaiRealtimeTranscriptionEncoding | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "ulaw" || normalized === "g711_ulaw" || normalized === "g711-mulaw") {
    return "mulaw";
  }
  if (normalized === "g711_alaw" || normalized === "g711-alaw") {
    return "alaw";
  }
  if (normalized === "pcm" || normalized === "mulaw" || normalized === "alaw") {
    return normalized;
  }
  throw new Error(`Invalid xAI realtime transcription encoding: ${normalized}`);
}

function normalizeXaiRealtimeBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

function toXaiRealtimeWsUrl(config: XaiRealtimeTranscriptionSessionConfig): string {
  const url = new URL(normalizeXaiRealtimeBaseUrl(config.baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/stt`;
  url.searchParams.set("sample_rate", String(config.sampleRate));
  url.searchParams.set("encoding", config.encoding);
  url.searchParams.set("interim_results", String(config.interimResults));
  url.searchParams.set("endpointing", String(config.endpointingMs));
  if (config.language) {
    url.searchParams.set("language", config.language);
  }
  return url.toString();
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): XaiRealtimeTranscriptionProviderConfig {
  const raw = readNestedXaiConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.xai.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    sampleRate: readFiniteNumber(raw.sampleRate ?? raw.sample_rate),
    encoding: normalizeEncoding(raw.encoding),
    interimResults: readBoolean(raw.interimResults ?? raw.interim_results),
    endpointingMs: readFiniteNumber(raw.endpointingMs ?? raw.endpointing ?? raw.silenceDurationMs),
    language: normalizeOptionalString(raw.language),
  };
}

function readErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  const message = normalizeOptionalString(record?.message);
  const code = normalizeOptionalString(record?.code);
  return message ?? code ?? "xAI realtime transcription error";
}

function readTranscriptText(event: XaiRealtimeTranscriptionEvent): string | undefined {
  return normalizeOptionalString(event.text ?? event.transcript);
}

function createXaiRealtimeTranscriptionSession(
  config: XaiRealtimeTranscriptionSessionConfig,
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

  const handleEvent = (
    event: XaiRealtimeTranscriptionEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    if (event.type === "transcript.created") {
      transport.markReady();
      return;
    }
    if (!transport.isReady() && event.type === "error") {
      transport.failConnect(new Error(readErrorDetail(event.error ?? event.message)));
      return;
    }
    switch (event.type) {
      case "transcript.partial": {
        const text = readTranscriptText(event);
        if (!text) {
          return;
        }
        if (!speechStarted) {
          speechStarted = true;
          config.onSpeechStart?.();
        }
        if (event.is_final && event.speech_final) {
          emitTranscript(text);
          speechStarted = false;
          return;
        }
        config.onPartial?.(text);
        return;
      }
      case "transcript.done": {
        const text = readTranscriptText(event);
        if (text) {
          emitTranscript(text);
        }
        transport.closeNow();
        return;
      }
      case "error":
        config.onError?.(new Error(readErrorDetail(event.error ?? event.message)));
        return;
      default:
        return;
    }
  };

  return createRealtimeTranscriptionWebSocketSession<XaiRealtimeTranscriptionEvent>({
    providerId: "xai",
    callbacks: config,
    url: () => toXaiRealtimeWsUrl(config),
    headers: { Authorization: `Bearer ${config.apiKey}` },
    connectTimeoutMs: XAI_REALTIME_STT_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: XAI_REALTIME_STT_CLOSE_TIMEOUT_MS,
    maxReconnectAttempts: XAI_REALTIME_STT_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: XAI_REALTIME_STT_RECONNECT_DELAY_MS,
    maxQueuedBytes: XAI_REALTIME_STT_MAX_QUEUED_BYTES,
    connectTimeoutMessage: "xAI realtime transcription connection timeout",
    connectClosedBeforeReadyMessage: "xAI realtime transcription connection closed before ready",
    reconnectLimitMessage: "xAI realtime transcription reconnect limit reached",
    sendAudio: (audio, transport) => {
      transport.sendBinary(audio);
    },
    onClose: (transport) => {
      transport.sendJson({ type: "audio.done" });
    },
    onMessage: handleEvent,
  });
}

export function buildXaiRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "xai",
    label: "xAI Realtime Transcription",
    aliases: ["xai-realtime", "grok-stt-streaming"],
    autoSelectOrder: 25,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.XAI_API_KEY),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.XAI_API_KEY;
      if (!apiKey) {
        throw new Error("xAI API key missing");
      }
      return createXaiRealtimeTranscriptionSession({
        ...req,
        apiKey,
        baseUrl: normalizeXaiRealtimeBaseUrl(config.baseUrl),
        sampleRate: config.sampleRate ?? XAI_REALTIME_STT_DEFAULT_SAMPLE_RATE,
        encoding: config.encoding ?? XAI_REALTIME_STT_DEFAULT_ENCODING,
        interimResults: config.interimResults ?? true,
        endpointingMs: config.endpointingMs ?? XAI_REALTIME_STT_DEFAULT_ENDPOINTING_MS,
        language: config.language,
      });
    },
  };
}
