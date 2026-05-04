import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { asObject, trimToUndefined } from "openclaw/plugin-sdk/speech";
import { DEFAULT_GRADIUM_VOICE_ID, GRADIUM_VOICES, normalizeGradiumBaseUrl } from "./shared.js";
import { gradiumTTS } from "./tts.js";

type GradiumProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
};

function normalizeGradiumProviderConfig(rawConfig: Record<string, unknown>): GradiumProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.gradium) ?? asObject(rawConfig.gradium);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.gradium.apiKey",
    }),
    baseUrl: normalizeGradiumBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_GRADIUM_VOICE_ID,
  };
}

function readGradiumProviderConfig(config: SpeechProviderConfig): GradiumProviderConfig {
  const defaults = normalizeGradiumProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeGradiumBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: Record<string, unknown>;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voice":
    case "voice_id":
    case "voiceid":
    case "gradium_voice":
    case "gradiumvoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return {
        handled: true,
        overrides: { ...ctx.currentOverrides, voiceId: ctx.value },
      };
    default:
      return { handled: false };
  }
}

export function buildGradiumSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "gradium",
    label: "Gradium",
    autoSelectOrder: 30,
    voices: GRADIUM_VOICES.map((v) => v.id),
    resolveConfig: ({ rawConfig }) => normalizeGradiumProviderConfig(rawConfig),
    parseDirectiveToken,
    listVoices: async () => GRADIUM_VOICES.map((v) => ({ id: v.id, name: v.name })),
    isConfigured: ({ providerConfig }) =>
      Boolean(readGradiumProviderConfig(providerConfig).apiKey || process.env.GRADIUM_API_KEY),
    synthesize: async (req) => {
      const config = readGradiumProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const apiKey = config.apiKey || process.env.GRADIUM_API_KEY;
      if (!apiKey) {
        throw new Error("Gradium API key missing");
      }
      const wantsVoiceNote = req.target === "voice-note";
      const outputFormat = wantsVoiceNote ? "opus" : "wav";
      const audioBuffer = await gradiumTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: trimToUndefined(overrides.voiceId) ?? config.voiceId,
        outputFormat,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat,
        fileExtension: wantsVoiceNote ? ".opus" : ".wav",
        voiceCompatible: wantsVoiceNote,
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readGradiumProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const apiKey = config.apiKey || process.env.GRADIUM_API_KEY;
      if (!apiKey) {
        throw new Error("Gradium API key missing");
      }
      const outputFormat = "ulaw_8000";
      const sampleRate = 8_000;
      const audioBuffer = await gradiumTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: trimToUndefined(overrides.voiceId) ?? config.voiceId,
        outputFormat,
        timeoutMs: req.timeoutMs,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
