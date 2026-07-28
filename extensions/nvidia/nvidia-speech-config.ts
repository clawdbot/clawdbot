// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { asFiniteNumber, asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";

export const NVIDIA_ASR_BASE_URL =
  "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com";
export const NVIDIA_TTS_BASE_URL =
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
};

export function normalizeNvidiaBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeNvidiaTtsConfig(rawConfig: Record<string, unknown>): NvidiaTtsConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.nvidia) ?? asObject(rawConfig.nvidia) ?? rawConfig;
  return {
    apiKey:
      normalizeResolvedSecretInputString({
        value: raw.apiKey,
        path: "messages.tts.providers.nvidia.apiKey",
      }) ?? trimToUndefined(process.env.NVIDIA_API_KEY),
    baseUrl: normalizeNvidiaBaseUrl(
      trimToUndefined(raw.baseUrl) ??
        trimToUndefined(process.env.NVIDIA_TTS_BASE_URL) ??
        NVIDIA_TTS_BASE_URL,
    ),
    model: trimToUndefined(raw.model) ?? NVIDIA_DEFAULT_TTS_MODEL,
    voice: trimToUndefined(raw.voice) ?? NVIDIA_DEFAULT_VOICE,
    language: trimToUndefined(raw.language) ?? NVIDIA_DEFAULT_LANGUAGE,
    sampleRateHz: asFiniteNumber(raw.sampleRateHz) ?? 44_100,
    customDictionary: trimToUndefined(raw.customDictionary),
    customConfiguration: trimToUndefined(raw.customConfiguration),
  };
}
