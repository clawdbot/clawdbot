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
  audio_end_ms?: number;
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
const OPENAI_REALTIME_TRANSCRIPTION_AUDIO_BYTES_PER_MS = 8;
const OPENAI_REALTIME_TRANSCRIPTION_MIN_COMMIT_DURATION_MS = 100;
const OPENAI_REALTIME_TRANSCRIPTION_DEFAULT_MODEL = "gpt-4o-transcribe";
const OPENAI_REALTIME_TRANSCRIPTION_MAX_UNRESOLVED_ITEMS = 64;
const OPENAI_REALTIME_TRANSCRIPTION_MAX_ITEM_ID_BYTES = 1024;
const OPENAI_REALTIME_TRANSCRIPTION_MAX_RETAINED_TRANSCRIPT_BYTES = 256 * 1024;
const OPENAI_REALTIME_TRANSCRIPTION_MAX_SETTLED_ITEMS = 4096;
const OPENAI_REALTIME_TRANSCRIPTION_MAX_SETTLED_ID_BYTES = 256 * 1024;
const OPENAI_REALTIME_TRANSCRIPTION_ITEM_OVERFLOW_MESSAGE =
  "OpenAI realtime transcription exceeded the 64 unresolved item limit";
const OPENAI_REALTIME_TRANSCRIPTION_IDENTITY_OVERFLOW_MESSAGE =
  "OpenAI realtime transcription exceeded the 1024-byte item identity limit";
const OPENAI_REALTIME_TRANSCRIPTION_TEXT_OVERFLOW_MESSAGE =
  "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit";
const OPENAI_REALTIME_TRANSCRIPTION_SETTLED_OVERFLOW_MESSAGE =
  "OpenAI realtime transcription exceeded the terminal item history limit";
const OPENAI_REALTIME_TRANSCRIPTION_API_KEY_REQUIRED =
  "OpenAI Realtime transcription requires an OpenAI Platform API key";
const OPENAI_REALTIME_TRANSCRIPTION_API_KEY_REJECTED =
  "OpenAI Realtime transcription rejected the selected API key. Update or remove the active OpenAI API-key source";

function appendedUtf8ByteLength(previous: string, appended: string): number {
  const appendedBytes = Buffer.byteLength(appended, "utf8");
  if (!previous || !appended) {
    return appendedBytes;
  }
  const previousCodeUnit = previous.charCodeAt(previous.length - 1);
  const appendedCodeUnit = appended.charCodeAt(0);
  const joinsSurrogatePair =
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    appendedCodeUnit >= 0xdc00 &&
    appendedCodeUnit <= 0xdfff;
  return joinsSurrogatePair ? appendedBytes - 2 : appendedBytes;
}

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
  const pendingTranscripts = new Map<string, { bytes: number; text: string }>();
  const committedItemIds: string[] = [];
  const committedItems = new Map<string, string | null | undefined>();
  const completedTranscripts = new Map<string, string | undefined>();
  const trackedItemIds = new Set<string>();
  const settledItemIds = new Set<string>();
  const unkeyedTranscript = "__openclaw_unkeyed_transcript__";
  let retainedTranscriptBytes = 0;
  let settledItemIdBytes = 0;
  let appendedAudioBytes = 0;
  let committedAudioBytes = 0;
  let lastVadBoundary: { itemId: string; audioEndBytes: number } | undefined;

  const resetTranscriptionState = () => {
    pendingTranscripts.clear();
    committedItemIds.length = 0;
    committedItems.clear();
    completedTranscripts.clear();
    trackedItemIds.clear();
    settledItemIds.clear();
    retainedTranscriptBytes = 0;
    settledItemIdBytes = 0;
    appendedAudioBytes = 0;
    committedAudioBytes = 0;
    lastVadBoundary = undefined;
  };

  const failTerminal = (error: Error, transport: RealtimeTranscriptionWebSocketTransport) => {
    resetTranscriptionState();
    transport.closeNow();
    try {
      config.onError?.(error);
    } catch {
      // The provider terminal owns this outcome; observer failures must not
      // re-enter shared error dispatch or duplicate the terminal callback.
    }
  };

  const trackItem = (
    itemId: string,
    transport: RealtimeTranscriptionWebSocketTransport,
  ): boolean => {
    if (settledItemIds.has(itemId) || completedTranscripts.has(itemId)) {
      return false;
    }
    if (trackedItemIds.has(itemId)) {
      return true;
    }
    if (trackedItemIds.size >= OPENAI_REALTIME_TRANSCRIPTION_MAX_UNRESOLVED_ITEMS) {
      failTerminal(new Error(OPENAI_REALTIME_TRANSCRIPTION_ITEM_OVERFLOW_MESSAGE), transport);
      return false;
    }
    if (Buffer.byteLength(itemId, "utf8") > OPENAI_REALTIME_TRANSCRIPTION_MAX_ITEM_ID_BYTES) {
      failTerminal(new Error(OPENAI_REALTIME_TRANSCRIPTION_IDENTITY_OVERFLOW_MESSAGE), transport);
      return false;
    }
    trackedItemIds.add(itemId);
    return true;
  };

  const settleItem = (
    itemId: string,
    transport: RealtimeTranscriptionWebSocketTransport,
  ): boolean => {
    const itemIdBytes = Buffer.byteLength(itemId, "utf8");
    if (
      settledItemIds.size >= OPENAI_REALTIME_TRANSCRIPTION_MAX_SETTLED_ITEMS ||
      itemIdBytes > OPENAI_REALTIME_TRANSCRIPTION_MAX_SETTLED_ID_BYTES - settledItemIdBytes
    ) {
      failTerminal(new Error(OPENAI_REALTIME_TRANSCRIPTION_SETTLED_OVERFLOW_MESSAGE), transport);
      return false;
    }
    trackedItemIds.delete(itemId);
    // Predecessor satisfaction belongs to each active item. Recording it here
    // prevents terminal-history saturation from invalidating admitted state.
    for (const [candidateId, previousItemId] of committedItems) {
      if (previousItemId === itemId) {
        committedItems.set(candidateId, null);
      }
    }
    // Never evict terminal identities within a connection generation. Closing
    // at the bound preserves first-terminal precedence without unbounded state.
    settledItemIds.add(itemId);
    settledItemIdBytes += itemIdBytes;
    return true;
  };

  const commitItem = (
    itemId: string,
    previousItemId: string | null | undefined,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    if (settledItemIds.has(itemId) || committedItems.has(itemId) || !trackItem(itemId, transport)) {
      return;
    }
    if (
      previousItemId &&
      Buffer.byteLength(previousItemId, "utf8") > OPENAI_REALTIME_TRANSCRIPTION_MAX_ITEM_ID_BYTES
    ) {
      failTerminal(new Error(OPENAI_REALTIME_TRANSCRIPTION_IDENTITY_OVERFLOW_MESSAGE), transport);
      return;
    }
    committedItems.set(
      itemId,
      previousItemId && settledItemIds.has(previousItemId) ? null : previousItemId,
    );
    committedItemIds.push(itemId);

    const arrivalOrder = committedItemIds.splice(0);
    const successors = new Map<string, string>();
    for (const candidateId of arrivalOrder) {
      const previousId = committedItems.get(candidateId);
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
      const previousId = committedItems.get(candidateId);
      if (previousId == null || settledItemIds.has(previousId)) {
        appendChain(candidateId);
      }
    }
    for (const candidateId of arrivalOrder) {
      appendChain(candidateId);
    }
  };

  const flushCompletedTranscripts = (
    transport: RealtimeTranscriptionWebSocketTransport,
  ): boolean => {
    while (committedItemIds.length > 0) {
      const itemId = committedItemIds[0];
      if (!itemId || !completedTranscripts.has(itemId)) {
        return true;
      }
      const previousItemId = committedItems.get(itemId);
      if (
        previousItemId &&
        !settledItemIds.has(previousItemId) &&
        !committedItems.has(previousItemId)
      ) {
        return true;
      }
      committedItemIds.shift();
      committedItems.delete(itemId);
      if (!settleItem(itemId, transport)) {
        return false;
      }
      const transcript = completedTranscripts.get(itemId);
      completedTranscripts.delete(itemId);
      if (transcript) {
        retainedTranscriptBytes -= Buffer.byteLength(transcript, "utf8");
      }
      if (transcript) {
        config.onTranscript?.(transcript);
      }
    }
    return true;
  };

  const completeItem = (
    itemId: string | undefined,
    transcript: string | undefined,
    transport: RealtimeTranscriptionWebSocketTransport,
  ): boolean => {
    const key = itemId ?? unkeyedTranscript;
    if (itemId && !trackItem(itemId, transport)) {
      return false;
    }
    const partialBytes = pendingTranscripts.get(key)?.bytes ?? 0;
    pendingTranscripts.delete(key);
    retainedTranscriptBytes -= partialBytes;
    const transcriptBytes = transcript ? Buffer.byteLength(transcript, "utf8") : 0;
    if (
      transcriptBytes >
      OPENAI_REALTIME_TRANSCRIPTION_MAX_RETAINED_TRANSCRIPT_BYTES - retainedTranscriptBytes
    ) {
      failTerminal(new Error(OPENAI_REALTIME_TRANSCRIPTION_TEXT_OVERFLOW_MESSAGE), transport);
      return false;
    }
    if (!itemId || !committedItems.has(itemId)) {
      if (itemId) {
        if (!settleItem(itemId, transport)) {
          return false;
        }
      } else {
        trackedItemIds.delete(key);
      }
      if (transcript) {
        config.onTranscript?.(transcript);
      }
      return true;
    }
    completedTranscripts.set(itemId, transcript);
    retainedTranscriptBytes += transcriptBytes;
    return flushCompletedTranscripts(transport);
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
        if (
          event.item_id &&
          (committedItems.has(event.item_id) || settledItemIds.has(event.item_id)) &&
          lastVadBoundary?.itemId !== event.item_id
        ) {
          return;
        }
        committedAudioBytes =
          event.item_id && lastVadBoundary?.itemId === event.item_id
            ? Math.max(
                committedAudioBytes,
                Math.min(appendedAudioBytes, lastVadBoundary.audioEndBytes),
              )
            : appendedAudioBytes;
        if (event.item_id === lastVadBoundary?.itemId) {
          lastVadBoundary = undefined;
        }
        if (event.item_id) {
          commitItem(event.item_id, event.previous_item_id, transport);
        }
        return;

      case "input_audio_buffer.speech_stopped":
        if (
          event.item_id &&
          typeof event.audio_end_ms === "number" &&
          Number.isFinite(event.audio_end_ms) &&
          event.audio_end_ms >= 0
        ) {
          lastVadBoundary = {
            itemId: event.item_id,
            audioEndBytes: event.audio_end_ms * OPENAI_REALTIME_TRANSCRIPTION_AUDIO_BYTES_PER_MS,
          };
        }
        return;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          const key = event.item_id ?? unkeyedTranscript;
          if (!trackItem(key, transport)) {
            return;
          }
          const pendingTranscript = pendingTranscripts.get(key);
          const previousPartial = pendingTranscript?.text ?? "";
          const deltaBytes = appendedUtf8ByteLength(previousPartial, event.delta);
          if (
            deltaBytes >
            OPENAI_REALTIME_TRANSCRIPTION_MAX_RETAINED_TRANSCRIPT_BYTES - retainedTranscriptBytes
          ) {
            failTerminal(new Error(OPENAI_REALTIME_TRANSCRIPTION_TEXT_OVERFLOW_MESSAGE), transport);
            return;
          }
          const partial = `${previousPartial}${event.delta}`;
          pendingTranscripts.set(key, {
            bytes: (pendingTranscript?.bytes ?? 0) + deltaBytes,
            text: partial,
          });
          retainedTranscriptBytes += deltaBytes;
          config.onPartial?.(partial);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        completeItem(event.item_id, event.transcript, transport);
        return;

      case "conversation.item.input_audio_transcription.failed":
        if (
          event.item_id &&
          (settledItemIds.has(event.item_id) || completedTranscripts.has(event.item_id))
        ) {
          return;
        }
        if (completeItem(event.item_id, undefined, transport)) {
          config.onError?.(new Error(readRealtimeErrorDetail(event.error)));
        }
        return;

      case "input_audio_buffer.speech_started": {
        const key = event.item_id ?? unkeyedTranscript;
        const partialBytes = pendingTranscripts.get(key)?.bytes ?? 0;
        pendingTranscripts.delete(key);
        retainedTranscriptBytes -= partialBytes;
        if (!committedItems.has(key)) {
          trackedItemIds.delete(key);
        }
        config.onSpeechStart?.();
        return;
      }

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
      const sent = transport.sendJson({
        type: "input_audio_buffer.append",
        audio: audio.toString("base64"),
      });
      if (sent) {
        appendedAudioBytes += audio.byteLength;
      }
    },
    onClose: (transport) => {
      // Server VAD owns stopped audio before its ack; shorter manual commits are rejected.
      const ownedAudioBytes = Math.max(committedAudioBytes, lastVadBoundary?.audioEndBytes ?? 0);
      if (
        appendedAudioBytes - ownedAudioBytes >=
        OPENAI_REALTIME_TRANSCRIPTION_MIN_COMMIT_DURATION_MS *
          OPENAI_REALTIME_TRANSCRIPTION_AUDIO_BYTES_PER_MS
      ) {
        if (!transport.sendJson({ type: "input_audio_buffer.commit" })) {
          failTerminal(
            new Error(
              "OpenAI realtime transcription could not send its final audio commit; check the provider connection",
            ),
            transport,
          );
          return;
        }
        committedAudioBytes = appendedAudioBytes;
      }
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
