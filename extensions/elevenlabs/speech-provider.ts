// Elevenlabs provider module implements model/runtime integration.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictFiniteNumber, parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import {
  asBoolean,
  asFiniteNumber,
  asObject,
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  trimToUndefined,
} from "openclaw/plugin-sdk/speech";
import { resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-core";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveElevenLabsApiKeyWithProfileFallback } from "./config-api.js";
import { isValidElevenLabsVoiceId, normalizeElevenLabsBaseUrl } from "./shared.js";
import { elevenLabsTTS, elevenLabsTTSStream } from "./tts.js";
const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1,
};

const ELEVENLABS_TTS_MODELS = [
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_flash_v2",
  "eleven_turbo_v2_5",
  "eleven_monolingual_v1",
] as const;

function normalizeElevenLabsTtsModelId(value: string | undefined): string | undefined {
  switch (value) {
    case "eleven_turbo_v2_5":
      return "eleven_flash_v2_5";
    case "eleven_turbo_v2":
      return "eleven_flash_v2";
    default:
      return value;
  }
}

type ElevenLabsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    style: number;
    useSpeakerBoost: boolean;
    speed: number;
  };
};

function parseBooleanValue(value: string): boolean | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseNumberValue(value: string): number | undefined {
  return parseStrictFiniteNumber(value);
}

function normalizeVoiceSetting(value: unknown, min: number, max: number): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= min && number <= max ? number : undefined;
}

function normalizeElevenLabsSeed(value: unknown): number | undefined {
  const seed = asFiniteNumber(value);
  return seed !== undefined && Number.isSafeInteger(seed) && seed >= 0 && seed <= 4_294_967_295
    ? seed
    : undefined;
}

function normalizeElevenLabsLatencyTier(value: unknown): number | undefined {
  const latencyTier = asFiniteNumber(value);
  return latencyTier !== undefined &&
    Number.isSafeInteger(latencyTier) &&
    latencyTier >= 0 &&
    latencyTier <= 4
    ? latencyTier
    : undefined;
}

function normalizeVoiceSettings(
  rawVoiceSettings: Record<string, unknown> | undefined,
): Partial<ElevenLabsProviderConfig["voiceSettings"]> {
  return {
    ...(normalizeVoiceSetting(rawVoiceSettings?.stability, 0, 1) == null
      ? {}
      : { stability: normalizeVoiceSetting(rawVoiceSettings?.stability, 0, 1) }),
    ...(normalizeVoiceSetting(rawVoiceSettings?.similarityBoost, 0, 1) == null
      ? {}
      : { similarityBoost: normalizeVoiceSetting(rawVoiceSettings?.similarityBoost, 0, 1) }),
    ...(normalizeVoiceSetting(rawVoiceSettings?.style, 0, 1) == null
      ? {}
      : { style: normalizeVoiceSetting(rawVoiceSettings?.style, 0, 1) }),
    ...(asBoolean(rawVoiceSettings?.useSpeakerBoost) == null
      ? {}
      : { useSpeakerBoost: asBoolean(rawVoiceSettings?.useSpeakerBoost) }),
    ...(normalizeVoiceSetting(rawVoiceSettings?.speed, 0.5, 2) == null
      ? {}
      : { speed: normalizeVoiceSetting(rawVoiceSettings?.speed, 0.5, 2) }),
  };
}

function normalizeElevenLabsProviderConfig(
  rawConfig: Record<string, unknown>,
): ElevenLabsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.elevenlabs) ?? asObject(rawConfig.elevenlabs);
  const rawVoiceSettings = asObject(raw?.voiceSettings);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.elevenlabs.apiKey",
    }),
    baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_ELEVENLABS_VOICE_ID,
    modelId:
      normalizeElevenLabsTtsModelId(trimToUndefined(raw?.modelId)) ?? DEFAULT_ELEVENLABS_MODEL_ID,
    seed: normalizeElevenLabsSeed(raw?.seed),
    applyTextNormalization: trimToUndefined(raw?.applyTextNormalization) as
      | "auto"
      | "on"
      | "off"
      | undefined,
    languageCode: trimToUndefined(raw?.languageCode),
    voiceSettings: {
      ...DEFAULT_ELEVENLABS_VOICE_SETTINGS,
      ...normalizeVoiceSettings(rawVoiceSettings),
    },
  };
}

function readElevenLabsProviderConfig(config: SpeechProviderConfig): ElevenLabsProviderConfig {
  const defaults = normalizeElevenLabsProviderConfig({});
  const voiceSettings = asObject(config.voiceSettings);
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    modelId: normalizeElevenLabsTtsModelId(trimToUndefined(config.modelId)) ?? defaults.modelId,
    seed: normalizeElevenLabsSeed(config.seed) ?? defaults.seed,
    applyTextNormalization:
      (trimToUndefined(config.applyTextNormalization) as "auto" | "on" | "off" | undefined) ??
      defaults.applyTextNormalization,
    languageCode: trimToUndefined(config.languageCode) ?? defaults.languageCode,
    voiceSettings: {
      ...defaults.voiceSettings,
      ...normalizeVoiceSettings(voiceSettings),
    },
  };
}

function resolveElevenLabsApiKey(...candidates: Array<string | undefined>): string | undefined {
  return resolveSpeechProviderApiKey(
    ...candidates,
    resolveElevenLabsApiKeyWithProfileFallback() ?? undefined,
    process.env.XI_API_KEY,
  );
}

function resolveElevenLabsTalkApiKey(config: SpeechProviderConfig): string | undefined {
  if (config.apiKey === undefined) {
    return resolveElevenLabsApiKey();
  }
  return normalizeResolvedSecretInputString({
    value: config.apiKey,
    path: "talk.providers.elevenlabs.apiKey",
  });
}

function mergeVoiceSettingsOverride(
  ctx: SpeechDirectiveTokenParseContext,
  next: Record<string, unknown>,
): SpeechProviderOverrides {
  return {
    ...ctx.currentOverrides,
    voiceSettings: {
      ...asObject(ctx.currentOverrides?.voiceSettings),
      ...next,
    },
  };
}

function resolveVoiceSettingsOverride(
  base: ElevenLabsProviderConfig["voiceSettings"],
  overrides: unknown,
): ElevenLabsProviderConfig["voiceSettings"] {
  const voiceSettings = asObject(overrides);
  return {
    ...base,
    ...normalizeVoiceSettings(voiceSettings),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  try {
    switch (ctx.key) {
      case "voiceid":
      case "voice_id":
      case "elevenlabs_voice":
      case "elevenlabsvoice":
        if (!ctx.policy.allowVoice) {
          return { handled: true };
        }
        if (!isValidElevenLabsVoiceId(ctx.value)) {
          return { handled: true, warnings: [`invalid ElevenLabs voiceId "${ctx.value}"`] };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, voiceId: ctx.value },
        };
      case "model":
      case "modelid":
      case "model_id":
      case "elevenlabs_model":
      case "elevenlabsmodel":
        if (!ctx.policy.allowModelId) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, modelId: normalizeElevenLabsTtsModelId(ctx.value) },
        };
      case "stability": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid stability value"] };
        }
        requireInRange(value, 0, 1, "stability");
        return { handled: true, overrides: mergeVoiceSettingsOverride(ctx, { stability: value }) };
      }
      case "similarity":
      case "similarityboost":
      case "similarity_boost": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid similarityBoost value"] };
        }
        requireInRange(value, 0, 1, "similarityBoost");
        return {
          handled: true,
          overrides: mergeVoiceSettingsOverride(ctx, { similarityBoost: value }),
        };
      }
      case "style": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid style value"] };
        }
        requireInRange(value, 0, 1, "style");
        return { handled: true, overrides: mergeVoiceSettingsOverride(ctx, { style: value }) };
      }
      case "speed": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseNumberValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid speed value"] };
        }
        requireInRange(value, 0.5, 2, "speed");
        return { handled: true, overrides: mergeVoiceSettingsOverride(ctx, { speed: value }) };
      }
      case "speakerboost":
      case "speaker_boost":
      case "usespeakerboost":
      case "use_speaker_boost": {
        if (!ctx.policy.allowVoiceSettings) {
          return { handled: true };
        }
        const value = parseBooleanValue(ctx.value);
        if (value == null) {
          return { handled: true, warnings: ["invalid useSpeakerBoost value"] };
        }
        return {
          handled: true,
          overrides: mergeVoiceSettingsOverride(ctx, { useSpeakerBoost: value }),
        };
      }
      case "normalize":
      case "applytextnormalization":
      case "apply_text_normalization":
        if (!ctx.policy.allowNormalization) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: {
            ...ctx.currentOverrides,
            applyTextNormalization: normalizeApplyTextNormalization(ctx.value),
          },
        };
      case "language":
      case "languagecode":
      case "language_code":
        if (!ctx.policy.allowNormalization) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: {
            ...ctx.currentOverrides,
            languageCode: normalizeLanguageCode(ctx.value),
          },
        };
      case "seed":
        if (!ctx.policy.allowSeed) {
          return { handled: true };
        }
        return {
          handled: true,
          overrides: {
            ...ctx.currentOverrides,
            seed: normalizeSeed(parseStrictInteger(ctx.value) ?? Number.NaN),
          },
        };
      default:
        return { handled: false };
    }
  } catch (error) {
    return {
      handled: true,
      warnings: [formatErrorMessage(error)],
    };
  }
}

async function listElevenLabsVoices(params: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const normalizedBaseUrl = normalizeElevenLabsBaseUrl(params.baseUrl);
  const { response, release } = await fetchWithSsrFGuard({
    url: `${normalizedBaseUrl}/v1/voices`,
    init: {
      headers: {
        "xi-api-key": params.apiKey,
      },
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(normalizedBaseUrl),
    auditContext: "elevenlabs.voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs voices API error");
    const json = await readProviderJsonResponse<{
      voices?: Array<{
        voice_id?: string;
        name?: string;
        category?: string;
        description?: string;
      }>;
    }>(response, "elevenlabs.voices");
    return Array.isArray(json.voices)
      ? json.voices
          .map((voice) => ({
            id: voice.voice_id?.trim() ?? "",
            name: trimToUndefined(voice.name),
            category: trimToUndefined(voice.category),
            description: trimToUndefined(voice.description),
          }))
          .filter((voice) => voice.id.length > 0)
      : [];
  } finally {
    await release();
  }
}

type ElevenLabsSynthesisRequest = Pick<
  SpeechSynthesisRequest,
  "providerConfig" | "providerOverrides" | "text" | "timeoutMs"
>;

function resolveElevenLabsTtsRequest(
  req: ElevenLabsSynthesisRequest,
  options: Pick<Parameters<typeof elevenLabsTTS>[0], "outputFormat" | "latencyTier">,
): Parameters<typeof elevenLabsTTS>[0] {
  const config = readElevenLabsProviderConfig(req.providerConfig);
  const overrides = req.providerOverrides ?? {};
  const apiKey = resolveElevenLabsApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("ElevenLabs API key missing");
  }
  return {
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    voiceId: trimToUndefined(overrides.voiceId) ?? config.voiceId,
    modelId: normalizeElevenLabsTtsModelId(trimToUndefined(overrides.modelId)) ?? config.modelId,
    outputFormat: options.outputFormat,
    seed: normalizeElevenLabsSeed(overrides.seed) ?? config.seed,
    applyTextNormalization:
      (trimToUndefined(overrides.applyTextNormalization) as "auto" | "on" | "off" | undefined) ??
      config.applyTextNormalization,
    languageCode: trimToUndefined(overrides.languageCode) ?? config.languageCode,
    latencyTier: options.latencyTier,
    voiceSettings: resolveVoiceSettingsOverride(config.voiceSettings, overrides.voiceSettings),
    timeoutMs: req.timeoutMs,
  };
}

export function buildElevenLabsSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    autoSelectOrder: 20,
    defaultModel: DEFAULT_ELEVENLABS_MODEL_ID,
    models: ELEVENLABS_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeElevenLabsProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeElevenLabsProviderConfig(baseTtsConfig);
      const talkVoiceSettings = asObject(talkProviderConfig.voiceSettings);
      const resolvedTalkApiKey = resolveElevenLabsTalkApiKey(talkProviderConfig);
      return {
        ...base,
        ...(resolvedTalkApiKey === undefined ? {} : { apiKey: resolvedTalkApiKey }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeElevenLabsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : {
              modelId: normalizeElevenLabsTtsModelId(trimToUndefined(talkProviderConfig.modelId)),
            }),
        ...(normalizeElevenLabsSeed(talkProviderConfig.seed) == null
          ? {}
          : { seed: normalizeElevenLabsSeed(talkProviderConfig.seed) }),
        ...(trimToUndefined(talkProviderConfig.applyTextNormalization) == null
          ? {}
          : {
              applyTextNormalization: normalizeApplyTextNormalization(
                trimToUndefined(talkProviderConfig.applyTextNormalization),
              ),
            }),
        ...(trimToUndefined(talkProviderConfig.languageCode) == null
          ? {}
          : {
              languageCode: normalizeLanguageCode(trimToUndefined(talkProviderConfig.languageCode)),
            }),
        voiceSettings: {
          ...base.voiceSettings,
          ...normalizeVoiceSettings(talkVoiceSettings),
        },
      };
    },
    resolveTalkOverrides: ({ params }) => {
      const normalize = trimToUndefined(params.normalize);
      const language = normalizeLowercaseStringOrEmpty(trimToUndefined(params.language));
      const latencyTier = normalizeElevenLabsLatencyTier(params.latencyTier);
      const voiceSettings = {
        ...(normalizeVoiceSetting(params.speed, 0.5, 2) == null
          ? {}
          : { speed: normalizeVoiceSetting(params.speed, 0.5, 2) }),
        ...(normalizeVoiceSetting(params.stability, 0, 1) == null
          ? {}
          : { stability: normalizeVoiceSetting(params.stability, 0, 1) }),
        ...(normalizeVoiceSetting(params.similarity, 0, 1) == null
          ? {}
          : { similarityBoost: normalizeVoiceSetting(params.similarity, 0, 1) }),
        ...(normalizeVoiceSetting(params.style, 0, 1) == null
          ? {}
          : { style: normalizeVoiceSetting(params.style, 0, 1) }),
        ...(asBoolean(params.speakerBoost) == null
          ? {}
          : { useSpeakerBoost: asBoolean(params.speakerBoost) }),
      };
      return {
        ...(trimToUndefined(params.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(params.voiceId) }),
        ...(trimToUndefined(params.modelId) == null
          ? {}
          : { modelId: normalizeElevenLabsTtsModelId(trimToUndefined(params.modelId)) }),
        ...(trimToUndefined(params.outputFormat) == null
          ? {}
          : { outputFormat: trimToUndefined(params.outputFormat) }),
        ...(normalizeElevenLabsSeed(params.seed) == null
          ? {}
          : { seed: normalizeElevenLabsSeed(params.seed) }),
        ...(normalize == null
          ? {}
          : { applyTextNormalization: normalizeApplyTextNormalization(normalize) }),
        ...(language == null ? {} : { languageCode: normalizeLanguageCode(language) }),
        ...(latencyTier == null ? {} : { latencyTier }),
        ...(Object.keys(voiceSettings).length === 0 ? {} : { voiceSettings }),
      };
    },
    listVoices: async (req) => {
      const config = req.providerConfig
        ? readElevenLabsProviderConfig(req.providerConfig)
        : undefined;
      const requestValue = req.apiKey;
      const configValue = config?.apiKey;
      const apiKey = resolveElevenLabsApiKey(requestValue, configValue);
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      return listElevenLabsVoices({
        apiKey,
        baseUrl: req.baseUrl ?? config?.baseUrl,
        timeoutMs: req.timeoutMs,
      });
    },
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveElevenLabsApiKey(readElevenLabsProviderConfig(providerConfig).apiKey)),
    synthesize: async (req) => {
      const overrides = req.providerOverrides ?? {};
      const outputFormat =
        trimToUndefined(overrides.outputFormat) ??
        (req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128");
      const audioBuffer = await elevenLabsTTS(
        resolveElevenLabsTtsRequest(req, {
          outputFormat,
          latencyTier: normalizeElevenLabsLatencyTier(overrides.latencyTier),
        }),
      );
      return {
        audioBuffer,
        outputFormat,
        fileExtension: req.target === "voice-note" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    streamSynthesize: async (req) => {
      const overrides = req.providerOverrides ?? {};
      const outputFormat =
        trimToUndefined(overrides.outputFormat) ??
        (req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128");
      const stream = await elevenLabsTTSStream(
        resolveElevenLabsTtsRequest(req, {
          outputFormat,
          latencyTier: normalizeElevenLabsLatencyTier(overrides.latencyTier),
        }),
      );
      return {
        audioStream: stream.audioStream,
        outputFormat,
        fileExtension: req.target === "voice-note" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
        release: stream.release,
      };
    },
    synthesizeTelephony: async (req) => {
      const outputFormat = "pcm_22050";
      const sampleRate = 22_050;
      const audioBuffer = await elevenLabsTTS(resolveElevenLabsTtsRequest(req, { outputFormat }));
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
