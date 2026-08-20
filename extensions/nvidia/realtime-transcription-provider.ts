// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import {
  Client,
  Metadata,
  credentials,
  type ClientDuplexStream,
  type ServiceError,
} from "@grpc/grpc-js";
import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse } from "protobufjs";
import type { Type } from "protobufjs";
import {
  NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID,
  resolveNvidiaSpeechCatalogModel,
} from "./nvidia-speech-catalog.js";

const NVIDIA_REALTIME_ASR_SERVER = "grpc.nvcf.nvidia.com:443";
const NVIDIA_REALTIME_ASR_FUNCTION_ID = "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa";
const NVIDIA_REALTIME_ASR_RPC = "/nvidia.riva.asr.RivaSpeechRecognition/StreamingRecognize";
const NVIDIA_REALTIME_ASR_MODEL = "nvidia/nemotron-asr-streaming";
const MAX_BUFFERED_AUDIO_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

const RIVA_ASR_PROTO = `
syntax = "proto3";
package nvidia.riva.asr;
message RecognitionConfig {
  int32 encoding = 1;
  int32 sample_rate_hertz = 2;
  string language_code = 3;
  int32 max_alternatives = 4;
  int32 audio_channel_count = 7;
  bool enable_automatic_punctuation = 11;
  string model = 13;
}
message StreamingRecognitionConfig {
  RecognitionConfig config = 1;
  bool interim_results = 2;
}
message StreamingRecognizeRequest {
  oneof streaming_request {
    StreamingRecognitionConfig streaming_config = 1;
    bytes audio_content = 2;
  }
}
message SpeechRecognitionAlternative { string transcript = 1; }
message StreamingRecognitionResult {
  repeated SpeechRecognitionAlternative alternatives = 1;
  bool is_final = 2;
  float stability = 3;
}
message StreamingRecognizeResponse { repeated StreamingRecognitionResult results = 1; }
`;

const protoRoot = parse(RIVA_ASR_PROTO).root;
const requestType = protoRoot.lookupType("nvidia.riva.asr.StreamingRecognizeRequest") as Type;
const responseType = protoRoot.lookupType("nvidia.riva.asr.StreamingRecognizeResponse") as Type;

type NvidiaRealtimeConfig = {
  apiKey?: string;
  language?: string;
  model?: string;
  server?: string;
  functionId?: string;
};

type NvidiaStreamingResult = {
  alternatives?: Array<{ transcript?: string }>;
  isFinal?: boolean;
};
type NvidiaStreamingResponse = { results?: NvidiaStreamingResult[] };

function readNvidiaRealtimeConfig(
  rawConfig: RealtimeTranscriptionProviderConfig,
): NvidiaRealtimeConfig {
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
    server: normalizeOptionalString(nested.server),
    functionId: normalizeOptionalString(nested.functionId),
  };
}

function serializeRequest(value: unknown): Buffer {
  const payload = value as Record<string, unknown>;
  const error = requestType.verify(payload);
  if (error) {
    throw new Error(`Invalid NVIDIA realtime ASR request: ${error}`);
  }
  return Buffer.from(requestType.encode(requestType.create(payload)).finish());
}

function deserializeResponse(value: Buffer): NvidiaStreamingResponse {
  return responseType.toObject(responseType.decode(value), {
    defaults: false,
    arrays: true,
  }) as NvidiaStreamingResponse;
}

async function resolveNvidiaApiKey(
  config: NvidiaRealtimeConfig,
  cfg: RealtimeTranscriptionSessionCreateRequest["cfg"],
): Promise<string> {
  if (config.server && config.server !== NVIDIA_REALTIME_ASR_SERVER && !config.apiKey) {
    throw new Error("NVIDIA realtime ASR custom server requires an explicit apiKey");
  }
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

function createNvidiaRealtimeSession(
  req: RealtimeTranscriptionSessionCreateRequest,
  config: NvidiaRealtimeConfig,
): RealtimeTranscriptionSession {
  let client: Client | undefined;
  let call: ClientDuplexStream<unknown, NvidiaStreamingResponse> | undefined;
  let connected = false;
  let closed = false;
  let speechStarted = false;
  let terminalErrorSent = false;

  const reportError = (error: Error) => {
    if (terminalErrorSent || closed) {
      return;
    }
    terminalErrorSent = true;
    req.onError?.(error);
  };

  const closeTransport = () => {
    connected = false;
    call?.end();
    call = undefined;
    client?.close();
    client = undefined;
  };

  return {
    async connect() {
      if (connected) {
        return;
      }
      if (closed) {
        throw new Error("NVIDIA realtime ASR session is closed");
      }
      const apiKey = await resolveNvidiaApiKey(config, req.cfg);
      const catalogModel =
        config.server && config.functionId
          ? undefined
          : await resolveNvidiaSpeechCatalogModel({
              id: NVIDIA_CATALOG_REALTIME_ASR_MODEL_ID,
              modality: "asr",
            });
      const grpcCloud = catalogModel?.cloud.transport === "grpc" ? catalogModel.cloud : undefined;
      const server = config.server ?? grpcCloud?.server ?? NVIDIA_REALTIME_ASR_SERVER;
      const functionId =
        config.functionId ?? grpcCloud?.functionId ?? NVIDIA_REALTIME_ASR_FUNCTION_ID;
      const language = config.language ?? grpcCloud?.defaultLanguage ?? "en-US";
      client = new Client(server, credentials.createSsl());
      try {
        await new Promise<void>((resolve, reject) => {
          client?.waitForReady(Date.now() + CONNECT_TIMEOUT_MS, (error) =>
            error
              ? reject(new Error("NVIDIA realtime ASR connection timeout", { cause: error }))
              : resolve(),
          );
        });
      } catch (error) {
        closeTransport();
        throw error;
      }
      if (closed || !client) {
        closeTransport();
        throw new Error("NVIDIA realtime ASR session closed during connection");
      }
      const metadata = new Metadata();
      metadata.set("authorization", `Bearer ${apiKey}`);
      metadata.set("function-id", functionId);
      call = client.makeBidiStreamRequest(
        NVIDIA_REALTIME_ASR_RPC,
        serializeRequest,
        deserializeResponse,
        metadata,
      );
      call.on("data", (response: NvidiaStreamingResponse) => {
        for (const result of response.results ?? []) {
          const transcript = result.alternatives?.[0]?.transcript?.trim();
          if (!transcript) {
            continue;
          }
          if (!speechStarted) {
            speechStarted = true;
            req.onSpeechStart?.();
          }
          if (result.isFinal) {
            req.onTranscript?.(transcript);
            speechStarted = false;
          } else {
            req.onPartial?.(transcript);
          }
        }
      });
      call.on("error", (error: ServiceError) => {
        const failedClient = client;
        call = undefined;
        client = undefined;
        failedClient?.close();
        connected = false;
        reportError(new Error(`NVIDIA realtime ASR failed: ${error.details || error.message}`));
      });
      call.on("end", () => {
        client?.close();
        client = undefined;
        call = undefined;
        connected = false;
      });
      call.write({
        streamingConfig: {
          config: {
            encoding: 1,
            sampleRateHertz: 8_000,
            languageCode: language,
            maxAlternatives: 1,
            audioChannelCount: 1,
            enableAutomaticPunctuation: true,
            ...(config.model && config.model !== NVIDIA_REALTIME_ASR_MODEL
              ? { model: config.model }
              : {}),
          },
          interimResults: true,
        },
      });
      connected = true;
    },
    sendAudio(audio) {
      if (!connected || !call || closed) {
        return;
      }
      const pcm = mulawToPcm(audio);
      if (call.writableLength + pcm.byteLength > MAX_BUFFERED_AUDIO_BYTES) {
        reportError(new Error("NVIDIA realtime ASR audio buffer exceeded 2 MiB"));
        closeTransport();
        return;
      }
      call.write({ audioContent: pcm });
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      closeTransport();
    },
    isConnected() {
      return connected;
    },
  };
}

export function buildNvidiaRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "nvidia",
    label: "NVIDIA Nemotron ASR Streaming",
    aliases: ["nemotron-asr-streaming", "nvidia-realtime"],
    defaultModel: NVIDIA_REALTIME_ASR_MODEL,
    models: [NVIDIA_REALTIME_ASR_MODEL],
    autoSelectOrder: 55,
    resolveConfig: ({ rawConfig }) => readNvidiaRealtimeConfig(rawConfig),
    isConfigured: ({ providerConfig, cfg }) => {
      const config = readNvidiaRealtimeConfig(providerConfig);
      if (config.server && config.server !== NVIDIA_REALTIME_ASR_SERVER) {
        return Boolean(config.apiKey);
      }
      return Boolean(
        config.apiKey ||
        process.env.NVIDIA_API_KEY?.trim() ||
        isProviderAuthProfileConfigured({ provider: "nvidia", cfg }),
      );
    },
    createSession: (req) =>
      createNvidiaRealtimeSession(req, readNvidiaRealtimeConfig(req.providerConfig)),
  };
}
