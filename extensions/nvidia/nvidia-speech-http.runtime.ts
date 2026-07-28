// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import { transcodeAudioBufferToOpus } from "openclaw/plugin-sdk/media-runtime";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  createProviderOperationDeadline,
  postMultipartRequest,
  postTranscriptionRequest,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfigWithOriginTrust,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  NVIDIA_ASR_BASE_URL,
  NVIDIA_DEFAULT_ASR_MODEL,
  isNvidiaHostedAsrBaseUrl,
  normalizeNvidiaBaseUrl,
} from "./nvidia-speech-config.js";

const QUERY_FIELD_ALIASES: Readonly<Record<string, string>> = {
  boostedWordsScore: "boosted_lm_score",
  boostScore: "boosted_lm_score",
  customConfiguration: "custom_configuration",
  wordTimeOffsets: "word_time_offsets",
  automaticPunctuation: "enable_automatic_punctuation",
  profanityFilter: "profanity_filter",
};

const BOOSTED_WORD_KEYS = new Set(["boostedWords", "boostedLmWords", "boosted_lm_words"]);
const RESERVED_ASR_FIELDS = new Set(["file", "language", "model", "response_format"]);
const RIFF_HEADER = Buffer.from("RIFF");
const WAVE_HEADER = Buffer.from("WAVE");
const OGG_HEADER = Buffer.from("OggS");
const OPUS_HEADER = Buffer.from("OpusHead");
const FLAC_HEADER = Buffer.from("fLaC");
const DEFAULT_TTS_MAX_BYTES = 16 * 1024 * 1024;

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function parseBoostedWords(value: string | number | boolean): string[] {
  if (typeof value !== "string") {
    return [String(value)];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map(String)
          .map((word) => word.trim())
          .filter(Boolean);
      }
    } catch {
      // Fall through to the comma/newline representation.
    }
  }
  return trimmed
    .split(/[,\n]/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function appendAsrCustomizations(form: FormData, query: AudioTranscriptionRequest["query"]): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (BOOSTED_WORD_KEYS.has(key)) {
      for (const word of parseBoostedWords(value)) {
        form.append("boosted_lm_words", word);
      }
      continue;
    }
    const field = QUERY_FIELD_ALIASES[key] ?? toSnakeCase(key);
    if (RESERVED_ASR_FIELDS.has(field)) {
      continue;
    }
    form.append(field, String(value));
  }
}

function isMonoOggOpus(buffer: Buffer): boolean {
  if (!buffer.subarray(0, OGG_HEADER.length).equals(OGG_HEADER)) {
    return false;
  }
  const opusHeadOffset = buffer.indexOf(OPUS_HEADER);
  const channelCountOffset = opusHeadOffset + OPUS_HEADER.length + 1;
  return (
    opusHeadOffset >= 0 && channelCountOffset < buffer.length && buffer[channelCountOffset] === 1
  );
}

function isMonoFlac(buffer: Buffer): boolean {
  if (buffer.length < 21 || !buffer.subarray(0, FLAC_HEADER.length).equals(FLAC_HEADER)) {
    return false;
  }
  const metadataType = buffer[4]! & 0x7f;
  const metadataLength = (buffer[5]! << 16) | (buffer[6]! << 8) | buffer[7]!;
  if (metadataType !== 0 || metadataLength < 34 || buffer.length < 8 + metadataLength) {
    return false;
  }
  const channelsMinusOne = (buffer[20]! >> 1) & 0x07;
  const bitsPerSampleMinusOne = ((buffer[20]! & 0x01) << 4) | (buffer[21]! >> 4);
  return channelsMinusOne === 0 && bitsPerSampleMinusOne + 1 === 16;
}

function isMonoPcm16Wav(buffer: Buffer): boolean {
  if (
    buffer.length < 12 ||
    !buffer.subarray(0, RIFF_HEADER.length).equals(RIFF_HEADER) ||
    !buffer.subarray(8, 12).equals(WAVE_HEADER)
  ) {
    return false;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkId === "fmt ") {
      if (chunkSize < 16 || dataOffset + 16 > buffer.length) {
        return false;
      }
      const audioFormat = buffer.readUInt16LE(dataOffset);
      const channels = buffer.readUInt16LE(dataOffset + 2);
      const bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
      return audioFormat === 1 && channels === 1 && bitsPerSample === 16;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return false;
}

async function normalizeNvidiaAsrAudio(
  req: AudioTranscriptionRequest,
): Promise<AudioTranscriptionRequest> {
  if (isMonoOggOpus(req.buffer) || isMonoPcm16Wav(req.buffer) || isMonoFlac(req.buffer)) {
    return req;
  }
  const buffer = await transcodeAudioBufferToOpus({
    audioBuffer: req.buffer,
    inputFileName: req.fileName,
    outputFileName: "audio.opus",
    tempPrefix: "nvidia-asr-",
    timeoutMs: req.timeoutMs,
    channels: 1,
  });
  return {
    ...req,
    buffer,
    fileName: "audio.opus",
    mime: "audio/ogg",
  };
}

type AsrEndpoint = { baseUrl: string; model: string; hosted: boolean };

function resolveAsrTranscriptionUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1")
    ? `${baseUrl}/audio/transcriptions`
    : `${baseUrl}/v1/audio/transcriptions`;
}

function resolveTtsSynthesisUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? `${baseUrl}/audio/synthesize` : `${baseUrl}/v1/audio/synthesize`;
}

function resolveAsrEndpoint(req: AudioTranscriptionRequest): AsrEndpoint {
  const requestBaseUrl = req.baseUrl ? normalizeNvidiaBaseUrl(req.baseUrl) : undefined;
  const rawEnvBaseUrl = process.env.NVIDIA_ASR_BASE_URL?.trim() || undefined;
  const envBaseUrl = rawEnvBaseUrl ? normalizeNvidiaBaseUrl(rawEnvBaseUrl) : undefined;
  const customBaseUrl =
    requestBaseUrl && !isNvidiaHostedAsrBaseUrl(requestBaseUrl)
      ? requestBaseUrl
      : envBaseUrl && !isNvidiaHostedAsrBaseUrl(envBaseUrl)
        ? envBaseUrl
        : undefined;
  if (customBaseUrl) {
    const model = req.model?.trim() || NVIDIA_DEFAULT_ASR_MODEL;
    return {
      baseUrl: customBaseUrl,
      model,
      hosted: false,
    };
  }
  if (req.model && req.model !== NVIDIA_DEFAULT_ASR_MODEL) {
    throw new Error(`NVIDIA ASR model ${req.model} requires an explicit HTTP base URL`);
  }
  return {
    baseUrl: NVIDIA_ASR_BASE_URL,
    model: NVIDIA_DEFAULT_ASR_MODEL,
    hosted: true,
  };
}

async function transcribeAtEndpoint(
  req: AudioTranscriptionRequest,
  endpoint: AsrEndpoint,
): Promise<AudioTranscriptionResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const apiKey = endpoint.hosted && req.auth?.kind !== "none" ? req.apiKey?.trim() : undefined;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, trustConfiguredBaseUrlOrigin } =
    resolveProviderHttpRequestConfigWithOriginTrust({
      baseUrl: endpoint.baseUrl,
      defaultBaseUrl: endpoint.baseUrl,
      headers: req.headers,
      request: req.request,
      defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      provider: "nvidia",
      api: "nemotron-speech-asr",
      capability: "audio",
      transport: "media-understanding",
    });
  const form = buildAudioTranscriptionFormData({
    buffer: req.buffer,
    fileName: req.fileName,
    mime: req.mime,
    fields: {
      language: req.language?.trim() || "en-US",
      response_format: "json",
    },
  });
  appendAsrCustomizations(form, req.query);

  const { response, release } = await postTranscriptionRequest({
    url: resolveAsrTranscriptionUrl(baseUrl),
    headers,
    body: form,
    timeoutMs: req.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    ssrfPolicy: trustConfiguredBaseUrlOrigin
      ? ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)
      : undefined,
    auditContext: `NVIDIA ${endpoint.model} ASR`,
  });
  try {
    await assertOkOrThrowHttpError(response, `NVIDIA ${endpoint.model} transcription failed`);
    const payload = await readProviderJsonResponse<{ text?: string }>(response, "nvidia.asr");
    return {
      text: requireTranscriptionText(payload.text, "NVIDIA ASR response missing text"),
      model: endpoint.model,
    };
  } finally {
    await release();
  }
}

export async function transcribeNvidiaAudio(
  req: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const endpoint = resolveAsrEndpoint(req);
  const apiKey = req.auth?.kind === "none" ? undefined : req.apiKey?.trim();
  if (endpoint.hosted && !apiKey) {
    throw new Error("NVIDIA speech API key missing for hosted ASR");
  }
  const deadline = createProviderOperationDeadline({
    timeoutMs: req.timeoutMs,
    label: "NVIDIA ASR",
  });
  const resolveRemainingTimeoutMs = () =>
    resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: req.timeoutMs });
  const normalizedReq = await normalizeNvidiaAsrAudio({
    ...req,
    timeoutMs: resolveRemainingTimeoutMs(),
  });
  return await transcribeAtEndpoint(
    { ...normalizedReq, timeoutMs: resolveRemainingTimeoutMs() },
    endpoint,
  );
}

type MagpieSynthesizeParams = {
  text: string;
  apiKey?: string;
  baseUrl: string;
  voice: string;
  language: string;
  sampleRateHz: number;
  customDictionary?: string;
  customConfiguration?: string;
  timeoutMs: number;
  maxBytes?: number;
};

export async function magpieSynthesize(params: MagpieSynthesizeParams): Promise<Buffer> {
  const form = new FormData();
  form.append("text", params.text);
  form.append("language", params.language);
  form.append("voice", params.voice);
  form.append("encoding", "LINEAR_PCM");
  form.append("sample_rate_hz", String(params.sampleRateHz));
  if (params.customDictionary) {
    form.append("custom_dictionary", params.customDictionary);
  }
  if (params.customConfiguration) {
    form.append("custom_configuration", params.customConfiguration);
  }

  const baseUrl = normalizeNvidiaBaseUrl(params.baseUrl);
  const headers = new Headers();
  if (params.apiKey) {
    headers.set("Authorization", `Bearer ${params.apiKey}`);
  }
  const { response, release } = await postMultipartRequest({
    url: resolveTtsSynthesisUrl(baseUrl),
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl),
    auditContext: "NVIDIA Magpie TTS",
  });
  try {
    await assertOkOrThrowHttpError(response, "NVIDIA Magpie TTS failed");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("audio/") && !contentType.startsWith("application/octet-stream")) {
      throw new Error(
        `NVIDIA Magpie TTS returned unexpected content type: ${contentType || "none"}`,
      );
    }
    const audio = await readResponseWithLimit(response, params.maxBytes ?? DEFAULT_TTS_MAX_BYTES, {
      onOverflow: ({ maxBytes }) =>
        new Error(`NVIDIA Magpie TTS audio response exceeds ${maxBytes} bytes`),
    });
    if (audio.length === 0 || !audio.subarray(0, RIFF_HEADER.length).equals(RIFF_HEADER)) {
      throw new Error("NVIDIA Magpie TTS returned an invalid WAV response");
    }
    return audio;
  } finally {
    await release();
  }
}
