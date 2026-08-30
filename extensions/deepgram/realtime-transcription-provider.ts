// Deepgram provider module implements model/runtime integration.
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
  type RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString,
  parseBooleanValue as readBoolean,
  parseFiniteNumber as readFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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
  from_finalize?: boolean;
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
const DEEPGRAM_REALTIME_MAX_RETAINED_TRANSCRIPT_BYTES = 256 * 1024;
const DEEPGRAM_REALTIME_FINALIZE_FALLBACK_MS = DEEPGRAM_REALTIME_CLOSE_TIMEOUT_MS - 100;

function readNestedDeepgramConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.deepgram ?? raw?.deepgram ?? raw) ?? {};
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
  const resolved = normalizeOptionalString(value ?? process.env.DEEPGRAM_BASE_URL);
  if (!resolved) {
    return DEFAULT_DEEPGRAM_AUDIO_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error("Invalid Deepgram baseUrl: value is not a valid URL");
  }
  const { protocol } = parsed;
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "ws:" && protocol !== "wss:") {
    // Endpoint URLs can contain userinfo or sensitive query values. Keep the
    // error actionable without echoing the configured value.
    throw new Error(
      `Invalid Deepgram baseUrl: unsupported scheme "${protocol}" (expected http, https, ws, or wss)`,
    );
  }
  return resolved;
}

function toDeepgramRealtimeWsUrl(config: DeepgramRealtimeTranscriptionSessionConfig): string {
  const url = new URL(normalizeDeepgramRealtimeBaseUrl(config.baseUrl));
  // Self-hosted Deepgram may explicitly use ws:// without TLS. Translate only
  // matching HTTP schemes so direct WebSocket endpoints keep their contract.
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
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
  let speechStarted = false;
  let finalizedTranscript = "";
  let pendingPartial = "";
  let finalizeRequested = false;
  let finalizeFallbackFired = false;
  let finalizeFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let openedOnce = false;

  const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

  const joinTranscript = (left: string, right: string) =>
    collapseWhitespace(left && right ? `${left} ${right}` : left || right);

  const clearFinalizeFallback = () => {
    if (finalizeFallbackTimer) {
      clearTimeout(finalizeFallbackTimer);
      finalizeFallbackTimer = undefined;
    }
  };

  const clearTurn = () => {
    clearFinalizeFallback();
    finalizedTranscript = "";
    pendingPartial = "";
    speechStarted = false;
  };

  const updateTurn = (
    nextFinalized: string,
    nextPartial: string,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    const retainedBytes =
      Buffer.byteLength(nextFinalized, "utf8") + Buffer.byteLength(nextPartial, "utf8");
    if (retainedBytes > DEEPGRAM_REALTIME_MAX_RETAINED_TRANSCRIPT_BYTES) {
      clearTurn();
      config.onError?.(
        new Error(
          `Deepgram realtime retained transcript exceeded ${DEEPGRAM_REALTIME_MAX_RETAINED_TRANSCRIPT_BYTES} bytes`,
        ),
      );
      transport.closeNow();
      return false;
    }
    finalizedTranscript = nextFinalized;
    pendingPartial = nextPartial;
    return true;
  };

  const flushTurn = () => {
    const full = joinTranscript(finalizedTranscript, pendingPartial);
    clearTurn();
    if (full) {
      config.onTranscript?.(full);
    }
  };

  const flushFinalizedTurn = () => {
    const full = collapseWhitespace(finalizedTranscript);
    clearTurn();
    if (full) {
      config.onTranscript?.(full);
    }
  };

  const handleEvent = (
    event: DeepgramRealtimeTranscriptionEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    switch (event.type) {
      case "Results": {
        if (finalizeFallbackFired) {
          return;
        }
        const text = readTranscriptText(event);
        if (text && !speechStarted) {
          speechStarted = true;
          config.onSpeechStart?.();
        }
        if (event.speech_final || event.from_finalize) {
          const nextFinalized = text
            ? joinTranscript(finalizedTranscript, text)
            : finalizedTranscript;
          if (!updateTurn(nextFinalized, "", transport)) {
            return;
          }
          flushTurn();
          return;
        }
        if (!text) {
          return;
        }
        if (event.is_final) {
          const nextFinalized = joinTranscript(finalizedTranscript, text);
          if (!updateTurn(nextFinalized, "", transport)) {
            return;
          }
          config.onPartial?.(nextFinalized);
        } else {
          if (!updateTurn(finalizedTranscript, text, transport)) {
            return;
          }
          config.onPartial?.(joinTranscript(finalizedTranscript, text));
        }
        return;
      }
      case "SpeechStarted":
        speechStarted = true;
        config.onSpeechStart?.();
        return;
      case "Error":
      case "error":
        config.onError?.(new Error(readErrorDetail(event.error ?? event.message)));

      default:
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
    onOpen: () => {
      if (openedOnce) {
        // The replacement stream cannot replay confirmed text from the old
        // connection. Emit it as an interrupted turn, but discard its partial tail.
        flushFinalizedTurn();
      } else {
        openedOnce = true;
        clearTurn();
      }
      finalizeRequested = false;
      finalizeFallbackFired = false;
    },
    sendAudio: (audio, transport) => {
      transport.sendBinary(audio);
    },
    onClose: (transport) => {
      if (finalizeRequested) {
        return;
      }
      finalizeRequested = true;
      if (finalizedTranscript) {
        // Finalize may produce no Results event when Deepgram has no buffered
        // audio left. Preserve already-finalized text before core force-closes.
        finalizeFallbackTimer = setTimeout(() => {
          finalizeFallbackTimer = undefined;
          finalizeFallbackFired = true;
          try {
            flushFinalizedTurn();
          } catch (error) {
            try {
              config.onError?.(error instanceof Error ? error : new Error(String(error)));
            } catch {
              // Error observers must not turn close fallback into an uncaught timer exception.
            }
          }
        }, DEEPGRAM_REALTIME_FINALIZE_FALLBACK_MS);
      }
      transport.sendJson({ type: "Finalize" });
    },
    onMessage: (event, transport) => handleEvent(event, transport),
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
