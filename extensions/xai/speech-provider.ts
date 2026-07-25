// Xai provider module implements model/runtime integration.
import {
  isProviderAuthProfileConfigured,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  trimToUndefined,
  type SpeechDirectiveTokenParseContext,
  type SpeechProviderConfig,
  type SpeechProviderOverrides,
  type SpeechProviderPlugin,
  type SpeechSynthesisTarget,
} from "openclaw/plugin-sdk/speech";
import { resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-core";
import {
  asFiniteNumberInRange,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isValidXaiTtsVoice,
  listXaiTtsVoices,
  normalizeXaiLanguageCode,
  normalizeXaiTtsBaseUrl,
  XAI_BASE_URL,
  XAI_TTS_FALLBACK_VOICES,
  xaiTTS,
  xaiTTSStream,
} from "./tts.js";

const XAI_SPEECH_RESPONSE_FORMATS = ["mp3", "wav", "pcm", "mulaw", "alaw"] as const;
const DEFAULT_GENERATED_AUDIO_MAX_BYTES = 16 * 1024 * 1024;

type XaiSpeechResponseFormat = (typeof XAI_SPEECH_RESPONSE_FORMATS)[number];

type XaiTtsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: XaiSpeechResponseFormat;
};

type XaiTtsProviderOverrides = {
  voiceId?: string;
  language?: string;
  speed?: number;
};

function normalizeXaiSpeechSpeed(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0.7, max: 1.5 });
}

function normalizeXaiSpeechResponseFormat(value: unknown): XaiSpeechResponseFormat | undefined {
  const next = normalizeLowercaseStringOrEmpty(value);
  if (!next) {
    return undefined;
  }
  if (XAI_SPEECH_RESPONSE_FORMATS.some((format) => format === next)) {
    return next as XaiSpeechResponseFormat;
  }
  throw new Error(`Invalid xAI speech responseFormat: ${next}`);
}

function resolveSpeechResponseFormat(
  target: SpeechSynthesisTarget,
  configuredFormat?: XaiSpeechResponseFormat,
): XaiSpeechResponseFormat {
  // Voice-note consumers may transcode without raw codec/rate metadata.
  // Keep streamed output and buffered fallback self-describing.
  if (target === "voice-note") {
    return "mp3";
  }
  return configuredFormat ?? "mp3";
}

function responseFormatToFileExtension(
  format: XaiSpeechResponseFormat,
): ".mp3" | ".pcm" | ".wav" | ".mulaw" | ".alaw" {
  switch (format) {
    case "wav":
      return ".wav";
    case "pcm":
      return ".pcm";
    case "mulaw":
      return ".mulaw";
    case "alaw":
      return ".alaw";
    default:
      return ".mp3";
  }
}

function normalizeXaiProviderConfig(rawConfig: Record<string, unknown>): XaiTtsProviderConfig {
  const providers = rawConfig?.providers as Record<string, unknown> | undefined;
  const xai = (providers?.xai ?? rawConfig?.xai ?? rawConfig) as Record<string, unknown>;
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: xai?.apiKey,
      path: "tts.providers.xai.apiKey",
    }),
    baseUrl: normalizeXaiTtsBaseUrl(
      trimToUndefined(xai?.baseUrl) ?? trimToUndefined(process.env.XAI_BASE_URL) ?? XAI_BASE_URL,
    ),
    voiceId: trimToUndefined(xai?.voiceId ?? xai?.voice) ?? "eve",
    language: normalizeXaiLanguageCode(trimToUndefined(xai?.language ?? xai?.languageCode)),
    speed: normalizeXaiSpeechSpeed(xai?.speed),
    responseFormat: normalizeXaiSpeechResponseFormat(xai?.responseFormat),
  };
}

function readXaiProviderConfig(config: SpeechProviderConfig): XaiTtsProviderConfig {
  const normalized = normalizeXaiProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    voiceId: trimToUndefined(config.voiceId ?? config.voice) ?? normalized.voiceId,
    language:
      normalizeXaiLanguageCode(trimToUndefined(config.language ?? config.languageCode)) ??
      normalized.language,
    speed: normalizeXaiSpeechSpeed(config.speed) ?? normalized.speed,
    responseFormat:
      normalizeXaiSpeechResponseFormat(config.responseFormat) ?? normalized.responseFormat,
  };
}

function readXaiOverrides(overrides: SpeechProviderOverrides | undefined): XaiTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voiceId: trimToUndefined(overrides.voiceId ?? overrides.voice),
    language: normalizeXaiLanguageCode(trimToUndefined(overrides.language)),
    speed: normalizeXaiSpeechSpeed(overrides.speed),
  };
}

function resolveDirectXaiAudioApiKey(configApiKey?: string): string | undefined {
  return resolveSpeechProviderApiKey(configApiKey, process.env.XAI_API_KEY);
}

function resolveGeneratedAudioMaxBytes(req: {
  cfg: { agents?: { defaults?: { mediaMaxMb?: number } } };
}): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_AUDIO_MAX_BYTES;
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voice":
    case "voice_id":
    case "voiceid":
    case "xai_voice":
    case "xaivoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      if (!isValidXaiTtsVoice(ctx.value)) {
        return { handled: true, warnings: [`invalid xAI voice "${ctx.value}"`] };
      }
      return { handled: true, overrides: { voiceId: ctx.value } };
    default:
      return { handled: false };
  }
}

export function buildXaiSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "xai",
    label: "xAI",
    autoSelectOrder: 25,
    models: [],
    voices: XAI_TTS_FALLBACK_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeXaiProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeXaiProviderConfig(baseTtsConfig);
      const responseFormat = normalizeXaiSpeechResponseFormat(talkProviderConfig.responseFormat);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.xai.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeXaiTtsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(normalizeXaiLanguageCode(
          trimToUndefined(talkProviderConfig.language ?? talkProviderConfig.languageCode),
        ) == null
          ? {}
          : {
              language: normalizeXaiLanguageCode(
                trimToUndefined(talkProviderConfig.language ?? talkProviderConfig.languageCode),
              ),
            }),
        ...(normalizeXaiSpeechSpeed(talkProviderConfig.speed) == null
          ? {}
          : { speed: normalizeXaiSpeechSpeed(talkProviderConfig.speed) }),
        ...(responseFormat == null ? {} : { responseFormat }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId ?? params.voice) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId ?? params.voice) }),
      ...(normalizeXaiLanguageCode(trimToUndefined(params.language ?? params.languageCode)) == null
        ? {}
        : {
            language: normalizeXaiLanguageCode(
              trimToUndefined(params.language ?? params.languageCode),
            ),
          }),
      ...(normalizeXaiSpeechSpeed(params.speed) == null
        ? {}
        : { speed: normalizeXaiSpeechSpeed(params.speed) }),
    }),
    listVoices: async (req) => {
      const config = readXaiProviderConfig(req.providerConfig ?? {});
      const directApiKey = trimToUndefined(req.apiKey) ?? config.apiKey;
      const apiKey = await resolveOptionalXaiAudioApiKey(directApiKey, req.cfg);
      if (!apiKey) {
        return XAI_TTS_FALLBACK_VOICES.map((voice) => ({ id: voice, name: voice }));
      }
      return await listXaiTtsVoices({
        apiKey,
        baseUrl: normalizeXaiTtsBaseUrl(trimToUndefined(req.baseUrl) ?? config.baseUrl),
      });
    },
    isConfigured: ({ providerConfig, cfg }) =>
      Boolean(resolveDirectXaiAudioApiKey(readXaiProviderConfig(providerConfig).apiKey)) ||
      isProviderAuthProfileConfigured({ provider: "xai", cfg }),
    synthesize: async (req) => {
      const config = readXaiProviderConfig(req.providerConfig);
      const overrides = readXaiOverrides(req.providerOverrides);
      const apiKey = await resolveXaiAudioApiKey(config.apiKey, req.cfg);
      const responseFormat = resolveSpeechResponseFormat(req.target, config.responseFormat);
      const audioBuffer = await xaiTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: overrides.voiceId ?? config.voiceId,
        language: overrides.language ?? config.language,
        speed: overrides.speed ?? config.speed,
        responseFormat,
        timeoutMs: req.timeoutMs,
        maxBytes: resolveGeneratedAudioMaxBytes(req),
      });
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension: responseFormatToFileExtension(responseFormat),
        voiceCompatible: false,
      };
    },
    streamSynthesize: async (req) => {
      const config = readXaiProviderConfig(req.providerConfig);
      const overrides = readXaiOverrides(req.providerOverrides);
      const responseFormat = resolveSpeechResponseFormat(req.target, config.responseFormat);
      const apiKey = await resolveXaiAudioApiKey(config.apiKey, req.cfg);
      const stream = await xaiTTSStream({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: overrides.voiceId ?? config.voiceId,
        language: overrides.language ?? config.language,
        speed: overrides.speed ?? config.speed,
        responseFormat,
        timeoutMs: req.timeoutMs,
        maxBytes: resolveGeneratedAudioMaxBytes(req),
      });
      return {
        audioStream: stream.audioStream,
        outputFormat: responseFormat,
        fileExtension: responseFormatToFileExtension(responseFormat),
        voiceCompatible: false,
        release: stream.release,
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readXaiProviderConfig(req.providerConfig);
      const overrides = readXaiOverrides(req.providerOverrides);
      const apiKey = await resolveXaiAudioApiKey(config.apiKey, req.cfg);
      const outputFormat = "pcm" as const;
      const sampleRate = 24000;
      const audioBuffer = await xaiTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        voiceId: overrides.voiceId ?? config.voiceId,
        language: overrides.language ?? config.language,
        speed: overrides.speed ?? config.speed,
        responseFormat: outputFormat,
        timeoutMs: req.timeoutMs,
        maxBytes: resolveGeneratedAudioMaxBytes(req),
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}

// Resolve an xAI bearer for `/v1/tts`:
// 1. Configured `tts.providers.xai.apiKey` (or talk equivalent)
// 2. `XAI_API_KEY` env var
// 3. xAI OAuth auth profile (cfg-scoped)
async function resolveOptionalXaiAudioApiKey(
  configApiKey: string | undefined,
  cfg?: OpenClawConfig,
): Promise<string | undefined> {
  const direct = resolveDirectXaiAudioApiKey(configApiKey);
  if (direct) {
    return direct;
  }
  if (!cfg) {
    return undefined;
  }
  const auth = await resolveApiKeyForProvider({ provider: "xai", cfg });
  return trimToUndefined(auth?.apiKey);
}

async function resolveXaiAudioApiKey(
  configApiKey: string | undefined,
  cfg: OpenClawConfig,
): Promise<string> {
  const apiKey = await resolveOptionalXaiAudioApiKey(configApiKey, cfg);
  if (apiKey) {
    return apiKey;
  }
  throw new Error(
    "xAI credentials missing for TTS. Sign in with `openclaw onboard --auth-choice xai-oauth`, or run `openclaw onboard --auth-choice xai-api-key`, or set XAI_API_KEY.",
  );
}
