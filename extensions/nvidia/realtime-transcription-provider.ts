// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionProviderConfig,
  type RealtimeTranscriptionProviderPlugin,
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
  type RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription";
import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID,
  resolveNvidiaSpeechCatalogModel,
  type NvidiaSpeechRealtime,
} from "./nvidia-speech-catalog.js";

const FUNCTION_ID = "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa";
const SESSION_URL = `https://${FUNCTION_ID}.invocation.api.nvcf.nvidia.com/v1/realtime/transcription_sessions`;
const WEBSOCKET_URL = "wss://grpc.nvcf.nvidia.com:443/v1/realtime?intent=transcription";
const MODEL = "nvidia/nemotron-asr-streaming";
const SESSION_TIMEOUT_MS = 10_000;
const SESSION_RESPONSE_MAX_BYTES = 64 * 1024;
const INPUT_SAMPLE_RATE_HZ = 8_000;
const PCM16_BYTES_PER_SAMPLE = 2;
const PERIODIC_COMMIT_SECONDS = 20;
const PERIODIC_COMMIT_BYTES =
  INPUT_SAMPLE_RATE_HZ * PCM16_BYTES_PER_SAMPLE * PERIODIC_COMMIT_SECONDS;
const FINAL_TRANSCRIPT_TIMEOUT_MS = 10_000;

type NvidiaConfig = { apiKey?: string; language?: string; model?: string };
type NvidiaEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string } | string;
};
type SessionResponse = {
  client_secret: { value: string };
  input_audio_transcription?: Record<string, unknown>;
  recognition_config?: Record<string, unknown>;
};

function readConfig(rawConfig: RealtimeTranscriptionProviderConfig): NvidiaConfig {
  const raw = asOptionalRecord(rawConfig);
  const providers = asOptionalRecord(raw?.providers);
  const nested = asOptionalRecord(providers?.nvidia ?? raw?.nvidia ?? raw) ?? {};
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: nested.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.nvidia.apiKey",
    }),
    language: normalizeOptionalString(nested.language),
    model: normalizeOptionalString(nested.model),
  };
}

async function resolveApiKey(
  config: NvidiaConfig,
  cfg: RealtimeTranscriptionSessionCreateRequest["cfg"],
): Promise<string> {
  const direct = config.apiKey ?? process.env.NVIDIA_API_KEY?.trim();
  if (direct) {
    return direct;
  }
  if (cfg) {
    const auth = await resolveApiKeyForProvider({ provider: "nvidia", cfg });
    const profileKey = auth?.apiKey?.trim();
    if (profileKey) {
      return profileKey;
    }
  }
  throw new Error("NVIDIA API key missing for realtime ASR");
}

function parseSession(value: unknown): SessionResponse {
  if (!isRecord(value) || !isRecord(value.client_secret)) {
    throw new Error("NVIDIA realtime ASR session response is invalid");
  }
  const token = normalizeOptionalString(value.client_secret.value);
  if (!token || token.length > 16_384) {
    throw new Error("NVIDIA realtime ASR session response has no valid client secret");
  }
  return {
    client_secret: { value: token },
    ...(isRecord(value.input_audio_transcription)
      ? { input_audio_transcription: value.input_audio_transcription }
      : {}),
    ...(isRecord(value.recognition_config) ? { recognition_config: value.recognition_config } : {}),
  };
}

function parseRealtimeEvent(payload: Buffer): NvidiaEvent {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString());
  } catch (error) {
    throw new Error("NVIDIA realtime ASR returned malformed JSON", { cause: error });
  }
  if (!isRecord(value)) {
    throw new Error("NVIDIA realtime ASR returned an invalid event");
  }
  const errorValue = value.error;
  const error =
    typeof errorValue === "string"
      ? errorValue
      : isRecord(errorValue)
        ? { message: normalizeOptionalString(errorValue.message) }
        : undefined;
  return {
    type: normalizeOptionalString(value.type),
    delta: normalizeOptionalString(value.delta),
    transcript: normalizeOptionalString(value.transcript),
    ...(error ? { error } : {}),
  };
}

async function mintSession(apiKey: string, sessionUrl: string): Promise<SessionResponse> {
  const { response, release } = await fetchWithSsrFGuard({
    url: sessionUrl,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    timeoutMs: SESSION_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(sessionUrl),
    auditContext: "NVIDIA realtime ASR session",
  });
  try {
    await assertOkOrThrowProviderError(response, "NVIDIA realtime ASR session request failed");
    const payload = await readProviderJsonResponse<unknown>(
      response,
      "NVIDIA realtime ASR session",
      { maxBytes: SESSION_RESPONSE_MAX_BYTES },
    );
    return parseSession(payload);
  } finally {
    await release();
  }
}

function sessionUpdate(params: {
  language: string;
  model?: string;
  session: SessionResponse;
}): Record<string, unknown> {
  const transcription = isRecord(params.session.input_audio_transcription)
    ? params.session.input_audio_transcription
    : {};
  return {
    type: "transcription_session.update",
    session: {
      modalities: ["text"],
      input_audio_format: "pcm16",
      input_audio_params: { sample_rate_hz: INPUT_SAMPLE_RATE_HZ, num_channels: 1 },
      input_audio_transcription: {
        ...transcription,
        language: params.language,
        ...(params.model && params.model !== MODEL ? { model: params.model } : {}),
      },
      recognition_config: {
        ...(isRecord(params.session.recognition_config) ? params.session.recognition_config : {}),
        max_alternatives: 1,
        enable_automatic_punctuation: true,
      },
    },
  };
}

function handleEvent(
  event: NvidiaEvent,
  transport: RealtimeTranscriptionWebSocketTransport,
  speechStarted: { value: boolean },
): void {
  if (event.type === "transcription_session.updated") {
    transport.markReady();
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    const partial = normalizeOptionalString(event.delta ?? event.transcript);
    if (!partial) {
      return;
    }
    if (!speechStarted.value) {
      speechStarted.value = true;
      transport.callbacks.onSpeechStart?.();
    }
    transport.callbacks.onPartial?.(partial);
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const transcript = normalizeOptionalString(event.transcript);
    if (transcript) {
      if (!speechStarted.value) {
        transport.callbacks.onSpeechStart?.();
      }
      transport.callbacks.onTranscript?.(transcript);
    }
    speechStarted.value = false;
    return;
  }
  if (
    event.type === "conversation.item.input_audio_transcription.failed" ||
    event.type === "error"
  ) {
    const message =
      typeof event.error === "string"
        ? event.error
        : (normalizeOptionalString(event.error?.message) ?? "NVIDIA realtime ASR failed");
    const error = new Error(message);
    if (transport.isReady()) {
      transport.callbacks.onError?.(error);
    } else {
      transport.failConnect(error);
    }
  }
}

function createSession(
  req: RealtimeTranscriptionSessionCreateRequest,
  config: NvidiaConfig,
): RealtimeTranscriptionSession {
  let apiKey = "";
  let token = "";
  let hostedSession: SessionResponse | undefined;
  let endpoint: NvidiaSpeechRealtime = {
    transport: "websocket",
    sessionUrl: SESSION_URL,
    websocketUrl: WEBSOCKET_URL,
    requestStyle: "nvcf-realtime-transcription",
  };
  let functionId = FUNCTION_ID;
  let language = config.language ?? "en-US";
  let uncommittedPcmBytes = 0;
  const speechStarted = { value: false };

  return createRealtimeTranscriptionWebSocketSession<NvidiaEvent>({
    providerId: "nvidia",
    callbacks: req,
    url: async () => {
      apiKey = await resolveApiKey(config, req.cfg);
      const catalogModel = resolveNvidiaSpeechCatalogModel({
        id: NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID,
        modality: "asr",
      });
      if (catalogModel?.cloud.transport === "grpc") {
        functionId = catalogModel.cloud.functionId;
        language = config.language ?? catalogModel.cloud.defaultLanguage ?? language;
        endpoint = catalogModel.cloud.realtime ?? endpoint;
      }
      hostedSession = await mintSession(apiKey, endpoint.sessionUrl);
      token = hostedSession.client_secret.value;
      return endpoint.websocketUrl;
    },
    headers: () => ({ Authorization: `Bearer ${apiKey}`, "function-id": functionId }),
    protocols: () => ["realtime", `realtime-token.${token}`],
    parseMessage: parseRealtimeEvent,
    onOpen: (transport) => {
      uncommittedPcmBytes = 0;
      if (!hostedSession) {
        transport.failConnect(new Error("NVIDIA realtime ASR session was not initialized"));
        return;
      }
      transport.sendJson(sessionUpdate({ language, model: config.model, session: hostedSession }));
    },
    onMessage: (event, transport) => handleEvent(event, transport, speechStarted),
    sendAudio: (audio, transport) => {
      const pcm = mulawToPcm(audio);
      if (
        !transport.sendJson({
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        })
      ) {
        return;
      }
      uncommittedPcmBytes += pcm.byteLength;
      if (
        uncommittedPcmBytes >= PERIODIC_COMMIT_BYTES &&
        transport.sendJson({ type: "input_audio_buffer.commit" })
      ) {
        uncommittedPcmBytes = 0;
      }
    },
    onClose: (transport) => {
      if (uncommittedPcmBytes > 0) {
        transport.sendJson({ type: "input_audio_buffer.commit" });
        uncommittedPcmBytes = 0;
      }
      transport.sendJson({ type: "input_audio_buffer.done" });
    },
    closeTimeoutMs: FINAL_TRANSCRIPT_TIMEOUT_MS,
    connectTimeoutMessage: "NVIDIA realtime ASR connection timeout",
    connectClosedBeforeReadyMessage: "NVIDIA realtime ASR connection closed before ready",
  });
}

export function buildNvidiaRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "nvidia",
    label: "NVIDIA Nemotron ASR Streaming",
    aliases: ["nemotron-asr-streaming", "nvidia-realtime"],
    defaultModel: MODEL,
    models: [MODEL],
    autoSelectOrder: 55,
    resolveConfig: ({ rawConfig }) => readConfig(rawConfig),
    isConfigured: ({ providerConfig, cfg }) => {
      const config = readConfig(providerConfig);
      return Boolean(
        config.apiKey ||
        process.env.NVIDIA_API_KEY?.trim() ||
        isProviderAuthProfileConfigured({ provider: "nvidia", cfg }),
      );
    },
    createSession: (req) => createSession(req, readConfig(req.providerConfig)),
  };
}
