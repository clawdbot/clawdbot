import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import { asFiniteNumberInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_INWORLD_MODEL_ID,
  DEFAULT_INWORLD_VOICE_ID,
  type InworldAudioEncoding,
  INWORLD_TTS_MODELS,
  inworldTTS,
  listInworldVoices,
  normalizeInworldBaseUrl,
} from "./tts.js";

type InworldProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  temperature?: number;
};

type InworldProviderOverrides = {
  voiceId?: string;
  modelId?: string;
  temperature?: number;
};

function normalizeInworldTemperature(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0, minExclusive: true, max: 2 });
}

function normalizeInworldProviderConfig(rawConfig: Record<string, unknown>): InworldProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.inworld) ?? asObject(rawConfig.inworld);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.inworld.apiKey",
    }),
    baseUrl: normalizeInworldBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_INWORLD_VOICE_ID,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_INWORLD_MODEL_ID,
    temperature: normalizeInworldTemperature(raw?.temperature),
  };
}

function readInworldProviderConfig(config: SpeechProviderConfig): InworldProviderConfig {
  const defaults = normalizeInworldProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeInworldBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    modelId: trimToUndefined(config.modelId) ?? defaults.modelId,
    temperature: normalizeInworldTemperature(config.temperature) ?? defaults.temperature,
  };
}

function readInworldOverrides(
  overrides: SpeechProviderOverrides | undefined,
): InworldProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voiceId: trimToUndefined(overrides.voiceId ?? overrides.voice),
    modelId: trimToUndefined(overrides.modelId ?? overrides.model),
    temperature: normalizeInworldTemperature(overrides.temperature),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
    case "inworld_voice":
    case "inworldvoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voiceId: ctx.value } };
    case "model":
    case "modelid":
    case "model_id":
    case "inworld_model":
    case "inworldmodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { modelId: ctx.value } };
    case "temperature": {
      if (!ctx.policy.allowVoiceSettings) {
        return { handled: true };
      }
      const temperature = normalizeInworldTemperature(Number(ctx.value));
      if (temperature === undefined) {
        return { handled: true, warnings: [`invalid Inworld temperature "${ctx.value}"`] };
      }
      return { handled: true, overrides: { temperature } };
    }
    default:
      return { handled: false };
  }
}

export function buildInworldSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "inworld",
    label: "Inworld",
    autoSelectOrder: 30,
    defaultModel: DEFAULT_INWORLD_MODEL_ID,
    models: INWORLD_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeInworldProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeInworldProviderConfig(baseTtsConfig);
      const resolvedApiKey =
        talkProviderConfig.apiKey === undefined
          ? undefined
          : normalizeResolvedSecretInputString({
              value: talkProviderConfig.apiKey,
              path: "talk.providers.inworld.apiKey",
            });
      return {
        ...base,
        ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeInworldBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { modelId: trimToUndefined(talkProviderConfig.modelId) }),
        ...(normalizeInworldTemperature(talkProviderConfig.temperature) == null
          ? {}
          : { temperature: normalizeInworldTemperature(talkProviderConfig.temperature) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { modelId: trimToUndefined(params.modelId) }),
      ...(normalizeInworldTemperature(params.temperature) == null
        ? {}
        : { temperature: normalizeInworldTemperature(params.temperature) }),
    }),
    listVoices: async (req) => {
      const config = req.providerConfig ? readInworldProviderConfig(req.providerConfig) : undefined;
      const apiKey = req.apiKey || config?.apiKey || process.env.INWORLD_API_KEY;
      if (!apiKey) {
        throw new Error("Inworld API key missing");
      }
      return listInworldVoices({
        apiKey,
        baseUrl: req.baseUrl ?? config?.baseUrl,
      });
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(readInworldProviderConfig(providerConfig).apiKey || process.env.INWORLD_API_KEY),
    synthesize: async (req) => {
      const config = readInworldProviderConfig(req.providerConfig);
      const overrides = readInworldOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.INWORLD_API_KEY;
      if (!apiKey) {
        throw new Error("Inworld API key missing");
      }

      const useOpus = req.target === "voice-note";
      const audioEncoding: InworldAudioEncoding = useOpus ? "OGG_OPUS" : "MP3";

      const audioBuffer = await inworldTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: overrides.voiceId ?? config.voiceId,
        modelId: overrides.modelId ?? config.modelId,
        audioEncoding,
        temperature: overrides.temperature ?? config.temperature,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: audioEncoding.toLowerCase(),
        fileExtension: useOpus ? ".ogg" : ".mp3",
        voiceCompatible: useOpus,
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readInworldProviderConfig(req.providerConfig);
      const overrides = readInworldOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.INWORLD_API_KEY;
      if (!apiKey) {
        throw new Error("Inworld API key missing");
      }

      const sampleRate = 22_050;
      const audioBuffer = await inworldTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: overrides.voiceId ?? config.voiceId,
        modelId: overrides.modelId ?? config.modelId,
        audioEncoding: "PCM",
        sampleRateHertz: sampleRate,
        temperature: overrides.temperature ?? config.temperature,
        timeoutMs: req.timeoutMs,
      });

      return { audioBuffer, outputFormat: "pcm", sampleRate };
    },
  };
}
