// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT

import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import { trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  NVIDIA_DEFAULT_LANGUAGE,
  NVIDIA_DEFAULT_TTS_MODEL,
  NVIDIA_DEFAULT_VOICE,
  normalizeNvidiaTtsConfig,
} from "./nvidia-speech-config.js";

const MAGPIE_VOICES = [
  "Magpie-Multilingual.EN-US.Aria",
  "Magpie-Multilingual.EN-US.Jason",
  "Magpie-Multilingual.EN-US.Leo",
  "Magpie-Multilingual.ES-US.Diego",
  "Magpie-Multilingual.DE-DE.Leo",
  "Magpie-Multilingual.FR-FR.Pascal",
  "Magpie-Multilingual.ZH-CN.Mia",
  "Magpie-Multilingual.HI-IN.Aarav",
  "Magpie-Multilingual.JA-JP.Hana",
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
    }),
    isConfigured: ({ providerConfig }) => Boolean(normalizeNvidiaTtsConfig(providerConfig).apiKey),
    synthesize: async (req) => {
      const config = normalizeNvidiaTtsConfig(req.providerConfig);
      if (!config.apiKey) {
        throw new Error("NVIDIA speech API key missing");
      }
      const overrides = req.providerOverrides ?? {};
      const { magpieSynthesize } = await import("./nvidia-speech-http.runtime.js");
      const audioBuffer = await magpieSynthesize({
        text: req.text,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        voice: trimToUndefined(overrides.voice) ?? config.voice ?? NVIDIA_DEFAULT_VOICE,
        language: trimToUndefined(overrides.language) ?? config.language ?? NVIDIA_DEFAULT_LANGUAGE,
        sampleRateHz: config.sampleRateHz,
        customDictionary: trimToUndefined(overrides.customDictionary) ?? config.customDictionary,
        customConfiguration:
          trimToUndefined(overrides.customConfiguration) ?? config.customConfiguration,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: true,
      };
    },
  };
}
