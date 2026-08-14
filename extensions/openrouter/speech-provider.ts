// Openrouter provider module implements model/runtime integration.
import {
  createOpenAiCompatibleSpeechProvider,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_TTS_MODEL = "hexgrad/kokoro-82m";
const DEFAULT_OPENROUTER_TTS_VOICE = "af_alloy";
const OPENROUTER_TTS_MODELS = [
  DEFAULT_OPENROUTER_TTS_MODEL,
  "elevenlabs/eleven-turbo-v2",
  "google/gemini-3.1-flash-tts-preview",
  "mistralai/voxtral-mini-tts-2603",
] as const;
const OPENROUTER_TTS_RESPONSE_FORMATS = ["mp3", "pcm"] as const;

type OpenRouterTtsExtraConfig = {
  provider?: Record<string, unknown>;
};

export function buildOpenRouterSpeechProvider(): SpeechProviderPlugin {
  return createOpenAiCompatibleSpeechProvider<OpenRouterTtsExtraConfig>({
    id: "openrouter",
    label: "OpenRouter",
    autoSelectOrder: 35,
    models: OPENROUTER_TTS_MODELS,
    voices: [DEFAULT_OPENROUTER_TTS_VOICE],
    defaultModel: DEFAULT_OPENROUTER_TTS_MODEL,
    defaultVoice: DEFAULT_OPENROUTER_TTS_VOICE,
    defaultBaseUrl: OPENROUTER_BASE_URL,
    envKey: "OPENROUTER_API_KEY",
    responseFormats: OPENROUTER_TTS_RESPONSE_FORMATS,
    defaultResponseFormat: "mp3",
    voiceCompatibleResponseFormats: ["mp3"],
    baseUrlPolicy: { kind: "canonical", aliases: ["https://openrouter.ai/v1"], allowCustom: true },
    extraHeaders: {
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
    },
    apiErrorLabel: "OpenRouter TTS API error",
    missingApiKeyError: "OpenRouter API key missing",
    readExtraConfig: (raw) => ({ provider: asOptionalRecord(raw?.provider) }),
    extraJsonBodyFields: [{ configKey: "provider" }],
  });
}
