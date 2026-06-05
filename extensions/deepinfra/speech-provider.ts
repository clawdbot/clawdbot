// Deepinfra provider module implements model/runtime integration.
import {
  asObject,
  createOpenAiCompatibleSpeechProvider,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_TTS_FALLBACK_MODELS,
  DEFAULT_DEEPINFRA_TTS_VOICE,
  normalizeDeepInfraModelRef,
} from "./media-models.js";
import type { DeepInfraSurfaceModel } from "./provider-models.js";

const DEEPINFRA_TTS_RESPONSE_FORMATS = ["mp3", "opus", "flac", "wav", "pcm"] as const;

type DeepInfraTtsExtraConfig = {
  extraBody?: Record<string, unknown>;
};

// First entry of ttsModels is the default; rest fill the allowlist.
export function buildDeepInfraSpeechProvider(options?: {
  ttsModels?: readonly DeepInfraSurfaceModel[];
}): SpeechProviderPlugin {
  const ids =
    options?.ttsModels && options.ttsModels.length > 0
      ? options.ttsModels.map((model) => model.id)
      : [...DEEPINFRA_TTS_FALLBACK_MODELS];
  const defaultModel = ids[0] ?? DEEPINFRA_TTS_FALLBACK_MODELS[0];
  return createOpenAiCompatibleSpeechProvider<DeepInfraTtsExtraConfig>({
    id: "deepinfra",
    label: "DeepInfra",
    autoSelectOrder: 45,
    models: ids,
    voices: [DEFAULT_DEEPINFRA_TTS_VOICE],
    defaultModel,
    defaultVoice: DEFAULT_DEEPINFRA_TTS_VOICE,
    defaultBaseUrl: DEEPINFRA_BASE_URL,
    envKey: "DEEPINFRA_API_KEY",
    responseFormats: DEEPINFRA_TTS_RESPONSE_FORMATS,
    defaultResponseFormat: "mp3",
    voiceCompatibleResponseFormats: ["mp3", "opus"],
    baseUrlPolicy: { kind: "trim-trailing-slash" },
    normalizeModel: normalizeDeepInfraModelRef,
    apiErrorLabel: "DeepInfra TTS API error",
    missingApiKeyError: "DeepInfra API key missing",
    readExtraConfig: (raw) => ({ extraBody: asObject(raw?.extraBody) }),
    extraJsonBodyFields: [{ configKey: "extraBody", requestKey: "extra_body" }],
  });
}
