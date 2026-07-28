// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import {
  isProviderAuthProfileConfigured,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import { trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  NVIDIA_DEFAULT_LANGUAGE,
  NVIDIA_DEFAULT_TTS_MODEL,
  NVIDIA_DEFAULT_VOICE,
  isNvidiaHostedTtsBaseUrl,
  normalizeNvidiaTtsConfig,
  resolveMagpieVoiceLanguage,
} from "./nvidia-speech-config.js";

const MAGPIE_VOICES = [
  "Magpie-Multilingual.EN-US.Aria",
  "Magpie-Multilingual.EN-US.Jason",
  "Magpie-Multilingual.EN-US.Leo",
  "Magpie-Multilingual.ES-US.Diego",
  "Magpie-Multilingual.DE-DE.Leo",
  "Magpie-Multilingual.FR-FR.Pascal",
  "Magpie-Multilingual.ZH-CN.HouZhen",
  "Magpie-Multilingual.HI-IN.Sofia",
  "Magpie-Multilingual.JA-JP.Isabela",
] as const;

export function buildNvidiaSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "nvidia",
    label: "NVIDIA Magpie",
    autoSelectOrder: 30,
    models: [NVIDIA_DEFAULT_TTS_MODEL],
    voices: MAGPIE_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeNvidiaTtsConfig(rawConfig),
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) ? { voice: trimToUndefined(params.voiceId) } : {}),
      ...(trimToUndefined(params.modelId) ? { model: trimToUndefined(params.modelId) } : {}),
      ...(trimToUndefined(params.language ?? params.languageCode)
        ? { language: trimToUndefined(params.language ?? params.languageCode) }
        : {}),
    }),
    isConfigured: ({ providerConfig, cfg }) => {
      const config = normalizeNvidiaTtsConfig(providerConfig);
      return (
        Boolean(config.apiKey) ||
        !isNvidiaHostedTtsBaseUrl(config.baseUrl) ||
        Boolean(trimToUndefined(process.env.NVIDIA_API_KEY)) ||
        isProviderAuthProfileConfigured({ provider: "nvidia", cfg })
      );
    },
    synthesize: async (req) => {
      const config = normalizeNvidiaTtsConfig(req.providerConfig);
      const apiKey = await resolveNvidiaSpeechApiKey(config.apiKey, config.baseUrl, req.cfg);
      const overrides = req.providerOverrides ?? {};
      const overrideVoice = trimToUndefined(overrides.voice);
      const voice = overrideVoice ?? config.voice ?? NVIDIA_DEFAULT_VOICE;
      const language =
        trimToUndefined(overrides.language) ??
        (overrideVoice ? resolveMagpieVoiceLanguage(voice) : undefined) ??
        config.language ??
        NVIDIA_DEFAULT_LANGUAGE;
      const { magpieSynthesize } = await import("./nvidia-speech-http.runtime.js");
      const audioBuffer = await magpieSynthesize({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voice,
        language,
        sampleRateHz: config.sampleRateHz,
        customDictionary: trimToUndefined(overrides.customDictionary) ?? config.customDictionary,
        customConfiguration:
          trimToUndefined(overrides.customConfiguration) ?? config.customConfiguration,
        timeoutMs: req.timeoutMs,
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
      });
      return {
        audioBuffer,
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      };
    },
  };
}

async function resolveNvidiaSpeechApiKey(
  configuredApiKey: string | undefined,
  baseUrl: string,
  cfg: OpenClawConfig,
): Promise<string | undefined> {
  const explicit = trimToUndefined(configuredApiKey);
  if (explicit) {
    return explicit;
  }
  if (!isNvidiaHostedTtsBaseUrl(baseUrl)) {
    return undefined;
  }
  const envKey = trimToUndefined(process.env.NVIDIA_API_KEY);
  if (envKey) {
    return envKey;
  }
  const auth = await resolveApiKeyForProvider({ provider: "nvidia", cfg });
  const profileKey = trimToUndefined(auth?.apiKey);
  if (profileKey) {
    return profileKey;
  }
  throw new Error(
    "NVIDIA credentials missing for TTS. Run `openclaw onboard --auth-choice nvidia-api-key` or set NVIDIA_API_KEY.",
  );
}
