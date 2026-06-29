// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postMultipartRequest,
  postTranscriptionRequest,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import {
  NVIDIA_CTC_ASR_BASE_URL,
  NVIDIA_DEFAULT_ASR_MODEL,
  NVIDIA_FALLBACK_ASR_MODEL,
  NVIDIA_TDT_ASR_BASE_URL,
  normalizeNvidiaBaseUrl,
} from "./nvidia-speech-config.js";

const QUERY_FIELD_ALIASES: Readonly<Record<string, string>> = {
  boostedWordsScore: "boosted_lm_score",
  boostScore: "boosted_lm_score",
  customConfiguration: "custom_configuration",
  wordTimeOffsets: "word_time_offsets",
  automaticPunctuation: "automatic_punctuation",
  profanityFilter: "profanity_filter",
};

const BOOSTED_WORD_KEYS = new Set(["boostedWords", "boostedLmWords", "boosted_lm_words"]);

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
    form.append(field, String(value));
  }
}

function isCtcModel(model: string | undefined): boolean {
  return model?.toLowerCase().includes("ctc") ?? false;
}

type AsrEndpoint = { baseUrl: string; model: string };

function resolveAsrEndpoints(model: string | undefined): AsrEndpoint[] {
  const tdtBaseUrl = normalizeNvidiaBaseUrl(
    process.env.NVIDIA_TDT_ASR_BASE_URL ?? NVIDIA_TDT_ASR_BASE_URL,
  );
  const ctcBaseUrl = normalizeNvidiaBaseUrl(
    process.env.NVIDIA_CTC_ASR_BASE_URL ?? NVIDIA_CTC_ASR_BASE_URL,
  );
  if (isCtcModel(model)) {
    return [{ baseUrl: ctcBaseUrl, model: NVIDIA_FALLBACK_ASR_MODEL }];
  }
  return [
    { baseUrl: tdtBaseUrl, model: NVIDIA_DEFAULT_ASR_MODEL },
    { baseUrl: ctcBaseUrl, model: NVIDIA_FALLBACK_ASR_MODEL },
  ];
}

async function transcribeAtEndpoint(
  req: AudioTranscriptionRequest,
  endpoint: AsrEndpoint,
): Promise<AudioTranscriptionResult> {
  const fetchFn = req.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: endpoint.baseUrl,
      defaultBaseUrl: endpoint.baseUrl,
      headers: req.headers,
      request: req.request,
      defaultHeaders: { Authorization: `Bearer ${req.apiKey}` },
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
    url: `${baseUrl}/v1/audio/transcriptions`,
    headers,
    body: form,
    timeoutMs: req.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
    auditContext: `NVIDIA ${endpoint.model} ASR`,
  });
  try {
    await assertOkOrThrowHttpError(response, `NVIDIA ${endpoint.model} transcription failed`);
    const payload = (await response.json()) as { text?: string };
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
  if (!req.apiKey) {
    throw new Error("NVIDIA speech API key missing");
  }
  const endpoints = resolveAsrEndpoints(req.model);
  const primary = endpoints[0];
  if (!primary) {
    throw new Error("NVIDIA ASR has no configured endpoint");
  }
  try {
    return await transcribeAtEndpoint(req, primary);
  } catch (primaryError) {
    const fallback = endpoints[1];
    if (!fallback) {
      throw primaryError;
    }
    try {
      return await transcribeAtEndpoint(req, fallback);
    } catch (fallbackError) {
      throw new Error("NVIDIA ASR failed for Parakeet TDT and Parakeet CTC fallback", {
        cause: fallbackError,
      });
    }
  }
}

export type MagpieSynthesizeParams = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voice: string;
  language: string;
  sampleRateHz: number;
  customDictionary?: string;
  customConfiguration?: string;
  timeoutMs: number;
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

  const { response, release } = await postMultipartRequest({
    url: `${normalizeNvidiaBaseUrl(params.baseUrl)}/v1/audio/synthesize`,
    headers: new Headers({ Authorization: `Bearer ${params.apiKey}` }),
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    auditContext: "NVIDIA Magpie TTS",
  });
  try {
    await assertOkOrThrowHttpError(response, "NVIDIA Magpie TTS failed");
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}
