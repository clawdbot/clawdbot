// Openai provider module implements model/runtime integration.
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
  item_id?: string;
  previous_item_id?: string | null;
  error?: unknown;
};

type OpenAIRealtimeTranscriptionSessionPayload = {
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
const OPENAI_REALTIME_TRANSCRIPTION_API_KEY_REQUIRED =
  "OpenAI Realtime transcription requires an OpenAI Platform API key";
const OPENAI_REALTIME_TRANSCRIPTION_API_KEY_REJECTED =
  "OpenAI Realtime transcription rejected the selected API key. Update or remove the active OpenAI API-key source";

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
    silenceDurationMs: normalizeNonNegativeInteger(raw?.silenceDurationMs),
    vadThreshold: normalizeVadThreshold(raw?.vadThreshold),
  };
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  if (number === undefined || !Number.isSafeInteger(number) || number < 0) {
    return undefined;
  }
  return number;
}

function normalizeVadThreshold(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  if (number === undefined || number < 0 || number > 1) {
    return undefined;
  }
  return number;
}

function buildOpenAIRealtimeTranscriptionSessionPayload(
  config: OpenAIRealtimeTranscriptionSessionConfig,
): OpenAIRealtimeTranscriptionSessionPayload {
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
  if (config.apiKey) {
    return config.apiKey;
  }
  const authToken = await resolveProviderAuthProfileApiKey({
    provider: "openai",
    cfg: config.cfg,
    profileTypes: ["api_key"],
  });
  if (authToken) {
    const clientSecret = await createOpenAIRealtimeTranscriptionClientSecret({
      authToken,
      auditContext: "openai-realtime-transcription-session",
      session: buildOpenAIRealtimeTranscriptionSessionPayload(config),
      authRejectedMessage: OPENAI_REALTIME_TRANSCRIPTION_API_KEY_REJECTED,
    });
    return clientSecret.value;
  }
  const envApiKey = process.env.OPENAI_API_KEY?.trim();
  if (envApiKey) {
    return envApiKey;
  }
  throw new Error(OPENAI_REALTIME_TRANSCRIPTION_API_KEY_REQUIRED);
}

function createOpenAIRealtimeTranscriptionSession(
  config: OpenAIRealtimeTranscriptionSessionConfig,
): RealtimeTranscriptionSession {
  const pendingTranscripts = new Map<string, string>();
  const committedItemIds: string[] = [];
  const committedItems = new Set<string>();
  const previousItemIds = new Map<string, string | null | undefined>();
  const settledItemIds = new Set<string>();
  const completedTranscripts = new Map<string, string | undefined>();
  const unkeyedTranscript = "__openclaw_unkeyed_transcript__";

  const resetTranscriptionState = () => {
    pendingTranscripts.clear();
    committedItemIds.length = 0;
    committedItems.clear();
    previousItemIds.clear();
    settledItemIds.clear();
    completedTranscripts.clear();
  };

  const commitItem = (itemId: string, previousItemId: string | null | undefined) => {
    if (committedItems.has(itemId)) {
      return;
    }
    committedItems.add(itemId);
    previousItemIds.set(itemId, previousItemId);
    committedItemIds.push(itemId);

    const arrivalOrder = committedItemIds.splice(0);
    const successors = new Map<string, string>();
    for (const candidateId of arrivalOrder) {
      const previousId = previousItemIds.get(candidateId);
      if (previousId) {
        successors.set(previousId, candidateId);
      }
    }
    const seen = new Set<string>();
    const appendChain = (startId: string) => {
      let candidateId: string | undefined = startId;
      while (candidateId && !seen.has(candidateId)) {
        seen.add(candidateId);
        committedItemIds.push(candidateId);
        candidateId = successors.get(candidateId);
      }
    };
    for (const candidateId of arrivalOrder) {
      const previousId = previousItemIds.get(candidateId);
      if (previousId == null || settledItemIds.has(previousId)) {
        appendChain(candidateId);
      }
    }
    for (const candidateId of arrivalOrder) {
      appendChain(candidateId);
    }
  };

  const flushCompletedTranscripts = () => {
    while (committedItemIds.length > 0) {
      const itemId = committedItemIds[0];
      if (!itemId || !completedTranscripts.has(itemId)) {
        return;
      }
      const previousItemId = previousItemIds.get(itemId);
      if (
        previousItemId &&
        !settledItemIds.has(previousItemId) &&
        !committedItems.has(previousItemId)
      ) {
        return;
      }
      committedItemIds.shift();
      committedItems.delete(itemId);
      previousItemIds.delete(itemId);
      settledItemIds.add(itemId);
      const transcript = completedTranscripts.get(itemId);
      completedTranscripts.delete(itemId);
      pendingTranscripts.delete(itemId);
      if (transcript) {
        config.onTranscript?.(transcript);
      }
    }
  };

  const completeItem = (itemId: string | undefined, transcript: string | undefined) => {
    const key = itemId ?? unkeyedTranscript;
    pendingTranscripts.delete(key);
    if (!itemId || !committedItems.has(itemId)) {
      if (transcript) {
        config.onTranscript?.(transcript);
      }
      return;
    }
    completedTranscripts.set(itemId, transcript);
    flushCompletedTranscripts();
  };

  const handleEvent = (
    event: RealtimeEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    switch (event.type) {
      case "session.updated":
      case "transcription_session.updated":
        transport.markReady();
        return;

      case "input_audio_buffer.committed":
        if (event.item_id) {
          commitItem(event.item_id, event.previous_item_id);
        }
        return;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          const key = event.item_id ?? unkeyedTranscript;
          const pendingTranscript = `${pendingTranscripts.get(key) ?? ""}${event.delta}`;
          pendingTranscripts.set(key, pendingTranscript);
          config.onPartial?.(pendingTranscript);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        completeItem(event.item_id, event.transcript);
        return;

      case "conversation.item.input_audio_transcription.failed":
        completeItem(event.item_id, undefined);
        config.onError?.(new Error(readRealtimeErrorDetail(event.error)));
        return;

      case "input_audio_buffer.speech_started":
        pendingTranscripts.delete(event.item_id ?? unkeyedTranscript);
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
      }

      default:
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
      // A reconnect starts a new provider session. Retaining outstanding item
      // state would splice pre-disconnect deltas into the first new turn.
      resetTranscriptionState();
      transport.sendJson({
        type: "session.update",
        session: buildOpenAIRealtimeTranscriptionSessionPayload(config),
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
        process.env.OPENAI_API_KEY?.trim() ||
        isProviderAuthProfileConfigured({ provider: "openai", cfg, profileTypes: ["api_key"] }),
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
