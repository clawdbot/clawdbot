// OpenAI-compatible realtime transcription provider.
//
// Wire protocol (intentionally minimal so any user can stand up a compatible
// STT service ÔÇö whisper.cpp server mode with a thin WebSocket shim,
// faster-whisper-server, vLLM, or a custom transcription worker):
//
//   client ÔåÆ server: binary frames of raw PCM audio (16-bit little-endian
//                    mono; the Gateway negotiates the actual sample rate with
//                    the provider's runtime, but 16 kHz is the universal
//                    default and what every mainstream STT engine supports).
//   server ÔåÆ client: JSON text frames, one event per message, in this shape:
//
//        { "type": "speech_start" }
//        { "type": "partial", "text": "hello wor" }
//        { "type": "final",   "text": "hello world" }
//        { "type": "error",   "message": "..." }
//
//   optional control messages (server ÔåÆ client) for cooperative shutdown:
//
//        { "type": "ready" }   // emitted once the server has loaded its model
//
// Servers may send only final transcripts (drop partials) and may omit
// `speech_start`; both are treated as best-effort hints rather than required
// protocol elements. Anything we do not recognize is ignored.
//
// The provider itself does not embed an HTTP client, retry policy, or audio
// codec ÔÇö that all lives in the shared
// `createRealtimeTranscriptionWebSocketSession` SDK helper so every bundled
// realtime transcription provider shares the same lifecycle, reconnect, and
// back-pressure guarantees.
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
  RealtimeTranscriptionWebSocketSessionOptions,
  RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import {
  asOptionalRecord,
  normalizeOptionalString,
  parseBooleanValue,
  parseFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type OpenAiCompatibleRealtimeTranscriptionProviderConfig = {
  /** WebSocket URL of the user's local STT endpoint. */
  endpoint?: string;
  /** Optional bearer/API key sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Optional model hint forwarded to the server (for OpenAI-compatible endpoints). */
  model?: string;
  /** Optional language hint (BCP-47, e.g. "en"). */
  language?: string;
  /** Optional sample rate override; defaults to 16000. */
  sampleRate?: number;
  /** Whether the server emits partial transcripts. Defaults to true. */
  interimResults?: boolean;
};

type OpenAiCompatibleRealtimeTranscriptionSessionConfig =
  RealtimeTranscriptionSessionCreateRequest & {
    endpoint: string;
    apiKey?: string;
    model: string;
    language?: string;
    sampleRate: number;
    interimResults: boolean;
  };

type OpenAiCompatibleRealtimeTranscriptionEvent = {
  type?: unknown;
  text?: unknown;
  message?: unknown;
};

const OPENAI_COMPATIBLE_STT_DEFAULT_MODEL = "whisper-1";
const OPENAI_COMPATIBLE_STT_DEFAULT_SAMPLE_RATE = 16000;
const OPENAI_COMPATIBLE_STT_DEFAULT_INTERIM_RESULTS = true;
const OPENAI_COMPATIBLE_STT_CONNECT_TIMEOUT_MS = 10_000;
const OPENAI_COMPATIBLE_STT_CLOSE_TIMEOUT_MS = 5_000;
const OPENAI_COMPATIBLE_STT_MAX_RECONNECT_ATTEMPTS = 5;
const OPENAI_COMPATIBLE_STT_RECONNECT_DELAY_MS = 1_000;
const OPENAI_COMPATIBLE_STT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const OPENAI_COMPATIBLE_STT_MAX_RETAINED_TRANSCRIPT_BYTES = 256 * 1024;

function readNestedConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = asOptionalRecord(rawConfig);
  const providers = asOptionalRecord(raw?.providers);
  return asOptionalRecord(providers?.["openai-compatible-stt"] ?? raw) ?? {};
}

function normalizeProviderConfig(
  rawConfig: RealtimeTranscriptionProviderConfig,
): OpenAiCompatibleRealtimeTranscriptionProviderConfig {
  const raw = readNestedConfig(rawConfig);
  return {
    endpoint: normalizeOptionalString(raw.endpoint ?? raw.url),
    apiKey: normalizeOptionalString(raw.apiKey),
    model: normalizeOptionalString(raw.model),
    language: normalizeOptionalString(raw.language),
    sampleRate: parseFiniteNumber(raw.sampleRate ?? raw.sample_rate),
    interimResults: parseBooleanValue(raw.interimResults ?? raw.interim_results),
  };
}

function resolveEndpoint(
  rawConfig: OpenAiCompatibleRealtimeTranscriptionProviderConfig,
): string | undefined {
  if (rawConfig.endpoint) {
    return rawConfig.endpoint;
  }
  return process.env.OPENAI_COMPATIBLE_STT_ENDPOINT || undefined;
}

function resolveApiKey(
  rawConfig: OpenAiCompatibleRealtimeTranscriptionProviderConfig,
): string | undefined {
  if (rawConfig.apiKey) {
    return rawConfig.apiKey;
  }
  return process.env.OPENAI_COMPATIBLE_STT_API_KEY || undefined;
}

function resolveSampleRate(rawConfig: OpenAiCompatibleRealtimeTranscriptionProviderConfig): number {
  if (typeof rawConfig.sampleRate === "number" && Number.isFinite(rawConfig.sampleRate)) {
    return Math.trunc(rawConfig.sampleRate);
  }
  return OPENAI_COMPATIBLE_STT_DEFAULT_SAMPLE_RATE;
}

function resolveInterimResults(
  rawConfig: OpenAiCompatibleRealtimeTranscriptionProviderConfig,
): boolean {
  return rawConfig.interimResults ?? OPENAI_COMPATIBLE_STT_DEFAULT_INTERIM_RESULTS;
}

function toWebSocketUrl(endpoint: string): string {
  const url = new URL(endpoint);
  // Accept http(s) as the user-friendly shorthand for ws(s); translate only
  // when the user did not explicitly request a WebSocket scheme so direct
  // WebSocket URLs preserve their contract.
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  // Always advertise the audio encoding so server-side decoders can route
  // the session without an out-of-band hello message.
  if (!url.searchParams.has("encoding")) {
    url.searchParams.set("encoding", "pcm_s16le");
  }
  return url.toString();
}

function buildEndpointUrl(config: OpenAiCompatibleRealtimeTranscriptionSessionConfig): string {
  const url = new URL(toWebSocketUrl(config.endpoint));
  if (config.model && !url.searchParams.has("model")) {
    url.searchParams.set("model", config.model);
  }
  if (!url.searchParams.has("sample_rate")) {
    url.searchParams.set("sample_rate", String(config.sampleRate));
  }
  if (!url.searchParams.has("interim_results")) {
    url.searchParams.set("interim_results", String(config.interimResults));
  }
  if (config.language && !url.searchParams.has("language")) {
    url.searchParams.set("language", config.language);
  }
  return url.toString();
}

function normalizeEvent(payload: Buffer): OpenAiCompatibleRealtimeTranscriptionEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  return parsed as OpenAiCompatibleRealtimeTranscriptionEvent;
}

function readEventText(event: OpenAiCompatibleRealtimeTranscriptionEvent): string | undefined {
  return typeof event.text === "string" ? event.text : undefined;
}

function readEventMessage(event: OpenAiCompatibleRealtimeTranscriptionEvent): string | undefined {
  if (typeof event.message === "string") {
    return event.message;
  }
  if (typeof event.text === "string") {
    return event.text;
  }
  return undefined;
}

type CreateSessionFactory = (
  options: RealtimeTranscriptionWebSocketSessionOptions<OpenAiCompatibleRealtimeTranscriptionEvent>,
) => RealtimeTranscriptionSession;

function createOpenAiCompatibleRealtimeTranscriptionSession(
  config: OpenAiCompatibleRealtimeTranscriptionSessionConfig,
  createRealtimeTranscriptionWebSocketSession: CreateSessionFactory,
): RealtimeTranscriptionSession {
  let finalizedTranscript = "";
  let pendingPartial = "";

  const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

  const joinTranscript = (left: string, right: string) =>
    collapseWhitespace(left && right ? `${left} ${right}` : left || right);

  const clearTurn = () => {
    finalizedTranscript = "";
    pendingPartial = "";
  };

  const updateTurn = (
    nextFinalized: string,
    nextPartial: string,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    const retainedBytes =
      Buffer.byteLength(nextFinalized, "utf8") + Buffer.byteLength(nextPartial, "utf8");
    if (retainedBytes > OPENAI_COMPATIBLE_STT_MAX_RETAINED_TRANSCRIPT_BYTES) {
      clearTurn();
      config.onError?.(
        new Error(
          `OpenAI-compatible STT retained transcript exceeded ${OPENAI_COMPATIBLE_STT_MAX_RETAINED_TRANSCRIPT_BYTES} bytes`,
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

  const handleEvent = (
    event: OpenAiCompatibleRealtimeTranscriptionEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    switch (event.type) {
      case "ready":
      case "speech_start": {
        config.onSpeechStart?.();
        return;
      }
      case "partial": {
        const text = readEventText(event);
        if (!text) {
          return;
        }
        const ok = updateTurn(finalizedTranscript, collapseWhitespace(text), transport);
        if (!ok) {
          return;
        }
        const live = joinTranscript(finalizedTranscript, pendingPartial);
        if (live) {
          config.onPartial?.(live);
        }
        return;
      }
      case "final":
      case "transcript": {
        const text = readEventText(event);
        if (text === undefined) {
          flushTurn();
          return;
        }
        const next = collapseWhitespace(text);
        const ok = updateTurn(next, "", transport);
        if (!ok) {
          return;
        }
        config.onTranscript?.(next);
        clearTurn();
        return;
      }
      case "error": {
        const message = readEventMessage(event);
        config.onError?.(new Error(message ?? "OpenAI-compatible STT error"));
        return;
      }
      default:
        return;
    }
  };

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  return createRealtimeTranscriptionWebSocketSession<OpenAiCompatibleRealtimeTranscriptionEvent>({
    providerId: "openai-compatible-stt",
    callbacks: config,
    url: () => buildEndpointUrl(config),
    headers,
    readyOnOpen: true,
    connectTimeoutMs: OPENAI_COMPATIBLE_STT_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: OPENAI_COMPATIBLE_STT_CLOSE_TIMEOUT_MS,
    maxReconnectAttempts: OPENAI_COMPATIBLE_STT_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: OPENAI_COMPATIBLE_STT_RECONNECT_DELAY_MS,
    maxQueuedBytes: OPENAI_COMPATIBLE_STT_MAX_QUEUED_BYTES,
    connectTimeoutMessage: "OpenAI-compatible STT connection timeout",
    parseMessage: normalizeEvent,
    sendAudio: (audio, transport) => {
      transport.sendBinary(audio);
    },
    onMessage: (event, transport) => {
      if (event) {
        handleEvent(event, transport);
      }
    },
    onClose: () => {
      flushTurn();
    },
  });
}

export function buildOpenAiCompatibleRealtimeTranscriptionProvider(params: {
  createRealtimeTranscriptionWebSocketSession: CreateSessionFactory;
}): RealtimeTranscriptionProviderPlugin {
  return {
    id: "openai-compatible-stt",
    label: "OpenAI-compatible STT (universal)",
    aliases: ["openai-compat-stt", "local-stt", "whisper-local"],
    defaultModel: OPENAI_COMPATIBLE_STT_DEFAULT_MODEL,
    autoSelectOrder: 80,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) => Boolean(resolveEndpoint(providerConfig)),
    createSession: (request) => {
      const normalized = normalizeProviderConfig(request.providerConfig);
      const endpoint = resolveEndpoint(normalized);
      if (!endpoint) {
        throw new Error(
          "OpenAI-compatible STT requires an endpoint URL. Configure plugins.entries.openai-compatible-stt.config.providers.openai-compatible-stt.endpoint or set OPENAI_COMPATIBLE_STT_ENDPOINT.",
        );
      }
      return createOpenAiCompatibleRealtimeTranscriptionSession(
        {
          ...request,
          endpoint,
          apiKey: resolveApiKey(normalized),
          model: normalized.model ?? OPENAI_COMPATIBLE_STT_DEFAULT_MODEL,
          language: normalized.language,
          sampleRate: resolveSampleRate(normalized),
          interimResults: resolveInterimResults(normalized),
        },
        params.createRealtimeTranscriptionWebSocketSession,
      );
    },
  };
}
