// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { asFiniteNumber, asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";

export const NVIDIA_ASR_BASE_URL =
  "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com";
const NVIDIA_CHAT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_TTS_BASE_URL =
  "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com";

export const NVIDIA_DEFAULT_ASR_MODEL = "nvidia/parakeet-ctc-1.1b-asr";
export const NVIDIA_DEFAULT_TTS_MODEL = "magpie-tts-multilingual";
export const NVIDIA_DEFAULT_VOICE = "Magpie-Multilingual.EN-US.Aria";
export const NVIDIA_DEFAULT_LANGUAGE = "en-US";

type NvidiaTtsConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  language: string;
  sampleRateHz: number;
  customDictionary?: string;
  customConfiguration?: string;
  routeStyle: NvidiaSpeechRouteStyle;
  modelPath?: string;
};

export type NvidiaSpeechRouteStyle = "fixed-model" | "model-path";

export function normalizeNvidiaSpeechRouteStyle(value: unknown): NvidiaSpeechRouteStyle {
  const normalized = trimToUndefined(value)?.toLowerCase();
  if (!normalized || normalized === "fixed-model") {
    return "fixed-model";
  }
  if (normalized === "model-path") {
    return "model-path";
  }
  throw new Error("Invalid NVIDIA speech routeStyle");
}

export function normalizeNvidiaSpeechModelPath(value: unknown): string | undefined {
  const normalized = trimToUndefined(value);
  if (!normalized) {
    return undefined;
  }
  const segmentPattern = new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$");
  const segments = normalized.split("/");
  if (segments.length !== 2 || segments.some((segment) => !segmentPattern.test(segment))) {
    throw new Error("Invalid NVIDIA speech modelPath (expected vendor/model)");
  }
  return normalized;
}

export function normalizeNvidiaBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeNvidiaTtsConfig(rawConfig: Record<string, unknown>): NvidiaTtsConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.nvidia) ?? asObject(rawConfig.nvidia) ?? rawConfig;
  const voice =
    trimToUndefined(raw.voice ?? raw.voiceId ?? raw.speakerVoiceId) ?? NVIDIA_DEFAULT_VOICE;
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "tts.providers.nvidia.apiKey",
    }),
    baseUrl: normalizeNvidiaBaseUrl(trimToUndefined(raw.baseUrl) ?? NVIDIA_TTS_BASE_URL),
    model: trimToUndefined(raw.model) ?? NVIDIA_DEFAULT_TTS_MODEL,
    voice,
    language:
      trimToUndefined(raw.language) ?? resolveMagpieVoiceLanguage(voice) ?? NVIDIA_DEFAULT_LANGUAGE,
    sampleRateHz: asFiniteNumber(raw.sampleRateHz) ?? 44_100,
    customDictionary: trimToUndefined(raw.customDictionary),
    customConfiguration: trimToUndefined(raw.customConfiguration),
    routeStyle: normalizeNvidiaSpeechRouteStyle(raw.routeStyle),
    modelPath: normalizeNvidiaSpeechModelPath(raw.modelPath),
  };
}

export function resolveMagpieVoiceLanguage(voice: string): string | undefined {
  const locale = /^Magpie-Multilingual\.([A-Za-z]{2})-([A-Za-z]{2})\./.exec(voice);
  const language = locale?.[1];
  const region = locale?.[2];
  return language && region ? `${language.toLowerCase()}-${region.toUpperCase()}` : undefined;
}

export function isNvidiaHostedAsrBaseUrl(value: string): boolean {
  const normalized = normalizeNvidiaBaseUrl(value);
  return (
    isHostedApiBaseUrl(normalized, NVIDIA_CHAT_BASE_URL) ||
    isHostedApiBaseUrl(normalized, NVIDIA_ASR_BASE_URL)
  );
}

export function isNvidiaHostedTtsBaseUrl(value: string): boolean {
  return isHostedApiBaseUrl(normalizeNvidiaBaseUrl(value), NVIDIA_TTS_BASE_URL);
}

function isHostedApiBaseUrl(value: string, hostedBaseUrl: string): boolean {
  return value === hostedBaseUrl || value === `${hostedBaseUrl}/v1`;
}
