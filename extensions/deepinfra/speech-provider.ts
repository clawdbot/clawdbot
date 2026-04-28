import {
  asObject,
  createOpenAiCompatibleSpeechProvider,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_TTS_MODELS,
  DEFAULT_DEEPINFRA_TTS_MODEL,
  DEFAULT_DEEPINFRA_TTS_VOICE,
  normalizeDeepInfraModelRef,
} from "./media-models.js";

const DEEPINFRA_TTS_RESPONSE_FORMATS = ["mp3", "opus", "flac", "wav", "pcm"] as const;

type DeepInfraTtsExtraConfig = {
  extraBody?: Record<string, unknown>;
};

export function buildDeepInfraSpeechProvider(): SpeechProviderPlugin {
  return createOpenAiCompatibleSpeechProvider<DeepInfraTtsExtraConfig>({
    id: "deepinfra",
    label: "DeepInfra",
    autoSelectOrder: 45,
    models: DEEPINFRA_TTS_MODELS,
    voices: [DEFAULT_DEEPINFRA_TTS_VOICE],
    defaultModel: DEFAULT_DEEPINFRA_TTS_MODEL,
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
