import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isProviderAuthProfileConfigured,
  resolveProviderAuthProfileApiKey,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
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
  asFiniteNumber,
  createOpenAIRealtimeTranscriptionClientSecret,
  readRealtimeErrorDetail,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";

type OpenAIRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  language?: string;
  model?: string;
  prompt?: string;
  silenceDurationMs?: number;
  vadThreshold?: number;
};

type OpenAIRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey?: string;
  cfg?: OpenClawConfig;
  language?: string;
  model: string;
  prompt?: string;
  silenceDurationMs: number;
  vadThreshold: number;
};

type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  error?: unknown;
};

type OpenAIRealtimeTranscriptionSessionCreate = {
  type: "transcription";
  audio: {
    input: {
      format: { type: "audio/pcmu" };
      transcription: {
        model: string;
        language?: string;
        prompt?: string;
      };
      turn_detection: {
        type: "server_vad";
        threshold: number;
        prefix_padding_ms: number;
        silence_duration_ms: number;
      };
    };
  };
};

type OpenAIRealtimeTranscriptionSessionUpdate = {
  type: "transcription";
  audio: {
    input: {
      format: { type: "audio/pcmu" };
      transcription: {
        model: string;
        language?: string;
        prompt?: string;
      };
      turn_detection: {
        type: "server_vad";
        threshold: number;
        prefix_padding_ms: number;
        silence_duration_ms: number;
      };
    };
  };
};

const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_REALTIME_TRANSCRIPTION_CONNECT_TIMEOUT_MS = 10_000;
const OPENAI_REALTIME_TRANSCRIPTION_MAX_RECONNECT_ATTEMPTS = 5;
const OPENAI_REALTIME_TRANSCRIPTION_RECONNECT_DELAY_MS = 1000;
const OPENAI_REALTIME_TRANSCRIPTION_DEFAULT_MODEL = "gpt-4o-transcribe";

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): OpenAIRealtimeTranscriptionProviderConfig {
  const raw = resolveOpenAIProviderConfigRecord(config);
  return {
    apiKey:
      normalizeResolvedSecretInputString({
        value: raw?.apiKey,
        path: "plugins.entries.voice-call.config.streaming.providers.openai.apiKey",
      }) ??
      normalizeResolvedSecretInputString({
        value: raw?.openaiApiKey,
        path: "plugins.entries.voice-call.config.streaming.openaiApiKey",
      }),
    language: trimToUndefined(raw?.language),
    model: trimToUndefined(raw?.model) ?? trimToUndefined(raw?.sttModel),
    prompt: trimToUndefined(raw?.prompt),
    silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
    vadThreshold: asFiniteNumber(raw?.vadThreshold),
  };
}

function buildOpenAIRealtimeTranscriptionSessionCreateConfig(
  config: OpenAIRealtimeTranscriptionSessionConfig,
): OpenAIRealtimeTranscriptionSessionCreate {
  return {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        transcription: {
          model: config.model,
          ...(config.language ? { language: config.language } : {}),
          ...(config.prompt ? { prompt: config.prompt } : {}),
        },
        turn_detection: {
          type: "server_vad",
          threshold: config.vadThreshold,
          prefix_padding_ms: 300,
          silence_duration_ms: config.silenceDurationMs,
        },
      },
    },
  };
}

function buildOpenAIRealtimeTranscriptionSessionUpdateConfig(
  config: OpenAIRealtimeTranscriptionSessionConfig,
): OpenAIRealtimeTranscriptionSessionUpdate {
  return {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        transcription: {
          model: config.model,
          ...(config.language ? { language: config.language } : {}),
          ...(config.prompt ? { prompt: config.prompt } : {}),
        },
        turn_detection: {
          type: "server_vad",
          threshold: config.vadThreshold,
          prefix_padding_ms: 300,
          silence_duration_ms: config.silenceDurationMs,
        },
      },
    },
  };
}

async function resolveOpenAIRealtimeTranscriptionAuthorization(
  config: OpenAIRealtimeTranscriptionSessionConfig,
): Promise<string> {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (apiKey) {
    return apiKey;
  }
  const authToken = await resolveProviderAuthProfileApiKey({
    provider: "openai-codex",
    cfg: config.cfg,
  });
  if (!authToken) {
    throw new Error("OpenAI API key or Codex OAuth missing");
  }
  const clientSecret = await createOpenAIRealtimeTranscriptionClientSecret({
    authToken,
    auditContext: "openai-realtime-transcription-session",
    session: buildOpenAIRealtimeTranscriptionSessionCreateConfig(config),
  });
  return clientSecret.value;
}

function createOpenAIRealtimeTranscriptionSession(
  config: OpenAIRealtimeTranscriptionSessionConfig,
): RealtimeTranscriptionSession {
  let pendingTranscript = "";

  const handleEvent = (
    event: RealtimeEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    switch (event.type) {
      case "session.updated":
      case "transcription_session.updated":
        transport.markReady();
        return;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          pendingTranscript += event.delta;
          config.onPartial?.(pendingTranscript);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          config.onTranscript?.(event.transcript);
        }
        pendingTranscript = "";
        return;

      case "input_audio_buffer.speech_started":
        pendingTranscript = "";
        config.onSpeechStart?.();
        return;

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        const error = new Error(detail);
        if (!transport.isReady()) {
          transport.failConnect(error);
        } else {
          config.onError?.(error);
        }
        return;
      }

      default:
        return;
    }
  };

  return createRealtimeTranscriptionWebSocketSession<RealtimeEvent>({
    providerId: "openai",
    callbacks: config,
    url: OPENAI_REALTIME_TRANSCRIPTION_URL,
    headers: async () => {
      const bearer = await resolveOpenAIRealtimeTranscriptionAuthorization(config);
      return (
        resolveProviderRequestHeaders({
          provider: "openai",
          baseUrl: OPENAI_REALTIME_TRANSCRIPTION_URL,
          capability: "audio",
          transport: "websocket",
          defaultHeaders: {
            Authorization: `Bearer ${bearer}`,
          },
        }) ?? {
          Authorization: `Bearer ${bearer}`,
        }
      );
    },
    connectTimeoutMs: OPENAI_REALTIME_TRANSCRIPTION_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: OPENAI_REALTIME_TRANSCRIPTION_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: OPENAI_REALTIME_TRANSCRIPTION_RECONNECT_DELAY_MS,
    connectTimeoutMessage: "OpenAI realtime transcription connection timeout",
    connectClosedBeforeReadyMessage: "OpenAI realtime transcription connection closed before ready",
    reconnectLimitMessage: "OpenAI realtime transcription reconnect limit reached",
    sendAudio: (audio, transport) => {
      transport.sendJson({
        type: "input_audio_buffer.append",
        audio: audio.toString("base64"),
      });
    },
    onOpen: (transport: RealtimeTranscriptionWebSocketTransport) => {
      transport.sendJson({
        type: "session.update",
        session: buildOpenAIRealtimeTranscriptionSessionUpdateConfig(config),
      });
    },
    onMessage: handleEvent,
  });
}

export function buildOpenAIRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI Realtime Transcription",
    aliases: ["openai-realtime"],
    defaultModel: OPENAI_REALTIME_TRANSCRIPTION_DEFAULT_MODEL,
    autoSelectOrder: 10,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        normalizeProviderConfig(providerConfig).apiKey ||
        process.env.OPENAI_API_KEY ||
        isProviderAuthProfileConfigured({ provider: "openai-codex", cfg }),
      ),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      return createOpenAIRealtimeTranscriptionSession({
        ...req,
        apiKey: config.apiKey,
        language: config.language,
        model: config.model ?? OPENAI_REALTIME_TRANSCRIPTION_DEFAULT_MODEL,
        prompt: config.prompt,
        silenceDurationMs: config.silenceDurationMs ?? 800,
        vadThreshold: config.vadThreshold ?? 0.5,
      });
    },
  };
}
