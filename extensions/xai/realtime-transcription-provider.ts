// Xai provider module implements model/runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
  type RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createXaiRealtimeTranscriptionProviderMetadata,
  normalizeXaiRealtimeTranscriptionProviderConfig,
  type XaiRealtimeTranscriptionEncoding,
} from "./capability-provider-metadata.js";
import { XAI_BASE_URL } from "./model-definitions.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

type XaiRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  // Late-bound bearer; called per (re)connect.
  resolveApiKey?: () => Promise<string>;
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

function readErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = isRecord(value) ? value : undefined;
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
          // Dedupe final/terminal echoes within one utterance, not identical later turns.
          lastTranscript = undefined;
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

      default:
    }
  };

  return createRealtimeTranscriptionWebSocketSession<XaiRealtimeTranscriptionEvent>({
    providerId: "xai",
    callbacks: config,
    url: () => toXaiRealtimeWsUrl(config),
    headers: async () => {
      const apiKey = config.resolveApiKey ? await config.resolveApiKey() : config.apiKey;
      return {
        Authorization: `Bearer ${apiKey}`,
        ...xaiUserAgentHeaderFor(config.baseUrl),
      };
    },
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
    ...createXaiRealtimeTranscriptionProviderMetadata(),
    createSession: (req) => {
      const config = normalizeXaiRealtimeTranscriptionProviderConfig(req.providerConfig);
      // createSession must stay sync per RealtimeTranscriptionProviderPlugin; bearer is resolved lazily in headers().
      const seedApiKey =
        normalizeOptionalString(config.apiKey) ?? normalizeOptionalString(process.env.XAI_API_KEY);
      return createXaiRealtimeTranscriptionSession({
        ...req,
        apiKey: seedApiKey ?? "",
        resolveApiKey: () => resolveXaiRealtimeApiKey(config.apiKey, req.cfg),
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

// Resolve an xAI bearer for the realtime `/stt` WebSocket:
// 1. Configured `plugins.entries.voice-call.config.streaming.providers.xai.apiKey`
// 2. `XAI_API_KEY` env var
// 3. xAI OAuth auth profile (cfg-scoped)
async function resolveXaiRealtimeApiKey(
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
    "xAI credentials missing for realtime STT. Sign in with `openclaw onboard --auth-choice xai-oauth`, or run `openclaw onboard --auth-choice xai-api-key`, or set XAI_API_KEY.",
  );
}
