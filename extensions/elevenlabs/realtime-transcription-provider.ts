import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
  type RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveElevenLabsApiKeyWithProfileFallback } from "./config-api.js";
import { normalizeElevenLabsBaseUrl } from "./shared.js";

type ElevenLabsRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  audioFormat?: string;
  sampleRate?: number;
  languageCode?: string;
  commitStrategy?: "manual" | "vad";
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
};

type ElevenLabsRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  audioFormat: string;
  sampleRate: number;
  commitStrategy: "manual" | "vad";
  languageCode?: string;
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
};

type ElevenLabsRealtimeTranscriptionEvent = {
  message_type?: string;
  text?: string;
  error?: string;
  message?: string;
  code?: string;
};

const ELEVENLABS_REALTIME_DEFAULT_MODEL = "scribe_v2_realtime";
const ELEVENLABS_REALTIME_DEFAULT_AUDIO_FORMAT = "ulaw_8000";
const ELEVENLABS_REALTIME_DEFAULT_SAMPLE_RATE = 8000;
const ELEVENLABS_REALTIME_DEFAULT_COMMIT_STRATEGY: "manual" | "vad" = "vad";
const ELEVENLABS_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const ELEVENLABS_REALTIME_CLOSE_TIMEOUT_MS = 5_000;
const ELEVENLABS_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
const ELEVENLABS_REALTIME_RECONNECT_DELAY_MS = 1000;
const ELEVENLABS_REALTIME_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNestedElevenLabsConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.elevenlabs ?? raw?.elevenlabs ?? raw) ?? {};
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

function normalizeCommitStrategy(value: unknown): "manual" | "vad" | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "manual" || normalized === "vad") {
    return normalized;
  }
  throw new Error(`Invalid ElevenLabs realtime transcription commit strategy: ${normalized}`);
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): ElevenLabsRealtimeTranscriptionProviderConfig {
  const raw = readNestedElevenLabsConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.elevenlabs.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    modelId: normalizeOptionalString(raw.modelId ?? raw.model ?? raw.sttModel),
    audioFormat: normalizeOptionalString(raw.audioFormat ?? raw.audio_format ?? raw.encoding),
    sampleRate: readFiniteNumber(raw.sampleRate ?? raw.sample_rate),
    languageCode: normalizeOptionalString(raw.languageCode ?? raw.language),
    commitStrategy: normalizeCommitStrategy(raw.commitStrategy ?? raw.commit_strategy),
    vadSilenceThresholdSecs: readFiniteNumber(
      raw.vadSilenceThresholdSecs ?? raw.vad_silence_threshold_secs,
    ),
    vadThreshold: readFiniteNumber(raw.vadThreshold ?? raw.vad_threshold),
    minSpeechDurationMs: readFiniteNumber(raw.minSpeechDurationMs ?? raw.min_speech_duration_ms),
    minSilenceDurationMs: readFiniteNumber(raw.minSilenceDurationMs ?? raw.min_silence_duration_ms),
  };
}

function normalizeElevenLabsRealtimeBaseUrl(value?: string): string {
  const url = new URL(normalizeElevenLabsBaseUrl(value));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString().replace(/\/+$/, "");
}

function toElevenLabsRealtimeWsUrl(config: ElevenLabsRealtimeTranscriptionSessionConfig): string {
  const url = new URL(
    `${normalizeElevenLabsRealtimeBaseUrl(config.baseUrl)}/v1/speech-to-text/realtime`,
  );
  url.searchParams.set("model_id", config.modelId);
  url.searchParams.set("audio_format", config.audioFormat);
  url.searchParams.set("commit_strategy", config.commitStrategy);
  url.searchParams.set("include_timestamps", "false");
  url.searchParams.set("include_language_detection", "false");
  if (config.languageCode) {
    url.searchParams.set("language_code", config.languageCode);
  }
  if (config.vadSilenceThresholdSecs != null) {
    url.searchParams.set("vad_silence_threshold_secs", String(config.vadSilenceThresholdSecs));
  }
  if (config.vadThreshold != null) {
    url.searchParams.set("vad_threshold", String(config.vadThreshold));
  }
  if (config.minSpeechDurationMs != null) {
    url.searchParams.set("min_speech_duration_ms", String(config.minSpeechDurationMs));
  }
  if (config.minSilenceDurationMs != null) {
    url.searchParams.set("min_silence_duration_ms", String(config.minSilenceDurationMs));
  }
  return url.toString();
}

function readErrorDetail(event: ElevenLabsRealtimeTranscriptionEvent): string {
  return (
    normalizeOptionalString(event.error) ??
    normalizeOptionalString(event.message) ??
    normalizeOptionalString(event.code) ??
    "ElevenLabs realtime transcription error"
  );
}

function createElevenLabsRealtimeTranscriptionSession(
  config: ElevenLabsRealtimeTranscriptionSessionConfig,
): RealtimeTranscriptionSession {
  let lastTranscript: string | undefined;

  const emitTranscript = (text: string) => {
    if (text === lastTranscript) {
      return;
    }
    lastTranscript = text;
    config.onTranscript?.(text);
  };

  const sendAudioChunk = (
    audio: Buffer,
    transport: RealtimeTranscriptionWebSocketTransport,
  ): void => {
    transport.sendJson({
      message_type: "input_audio_chunk",
      audio_base_64: audio.toString("base64"),
      sample_rate: config.sampleRate,
      ...(config.commitStrategy === "manual" ? { commit: true } : {}),
    });
  };

  const handleEvent = (
    event: ElevenLabsRealtimeTranscriptionEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    if (event.message_type === "session_started") {
      transport.markReady();
      return;
    }
    if (!transport.isReady() && event.message_type?.includes("error")) {
      transport.failConnect(new Error(readErrorDetail(event)));
      return;
    }
    switch (event.message_type) {
      case "partial_transcript":
        if (event.text) {
          config.onPartial?.(event.text);
        }
        return;
      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        if (event.text) {
          emitTranscript(event.text);
        }
        return;
      default:
        if (event.message_type?.includes("error")) {
          config.onError?.(new Error(readErrorDetail(event)));
        }
        return;
    }
  };

  return createRealtimeTranscriptionWebSocketSession<ElevenLabsRealtimeTranscriptionEvent>({
    providerId: "elevenlabs",
    callbacks: config,
    url: () => toElevenLabsRealtimeWsUrl(config),
    headers: { "xi-api-key": config.apiKey },
    connectTimeoutMs: ELEVENLABS_REALTIME_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: ELEVENLABS_REALTIME_CLOSE_TIMEOUT_MS,
    maxReconnectAttempts: ELEVENLABS_REALTIME_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: ELEVENLABS_REALTIME_RECONNECT_DELAY_MS,
    maxQueuedBytes: ELEVENLABS_REALTIME_MAX_QUEUED_BYTES,
    connectTimeoutMessage: "ElevenLabs realtime transcription connection timeout",
    reconnectLimitMessage: "ElevenLabs realtime transcription reconnect limit reached",
    sendAudio: sendAudioChunk,
    onClose: (transport) => {
      transport.sendJson({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        sample_rate: config.sampleRate,
        commit: true,
      });
    },
    onMessage: handleEvent,
  });
}

export function buildElevenLabsRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs Realtime Transcription",
    aliases: ["elevenlabs-realtime", "scribe-v2-realtime"],
    defaultModel: ELEVENLABS_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 40,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(
        normalizeProviderConfig(providerConfig).apiKey ||
        resolveElevenLabsApiKeyWithProfileFallback() ||
        process.env.XI_API_KEY,
      ),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey =
        config.apiKey || resolveElevenLabsApiKeyWithProfileFallback() || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      return createElevenLabsRealtimeTranscriptionSession({
        ...req,
        apiKey,
        baseUrl: normalizeElevenLabsBaseUrl(config.baseUrl),
        modelId: config.modelId ?? ELEVENLABS_REALTIME_DEFAULT_MODEL,
        audioFormat: config.audioFormat ?? ELEVENLABS_REALTIME_DEFAULT_AUDIO_FORMAT,
        sampleRate: config.sampleRate ?? ELEVENLABS_REALTIME_DEFAULT_SAMPLE_RATE,
        commitStrategy: config.commitStrategy ?? ELEVENLABS_REALTIME_DEFAULT_COMMIT_STRATEGY,
        languageCode: config.languageCode,
        vadSilenceThresholdSecs: config.vadSilenceThresholdSecs,
        vadThreshold: config.vadThreshold,
        minSpeechDurationMs: config.minSpeechDurationMs,
        minSilenceDurationMs: config.minSilenceDurationMs,
      });
    },
  };
}

export const __testing = {
  normalizeProviderConfig,
  toElevenLabsRealtimeWsUrl,
};
