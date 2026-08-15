import { isProviderAuthProfileConfigured } from "openclaw/plugin-sdk/provider-auth";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
  SpeechSynthesisTarget,
} from "openclaw/plugin-sdk/speech";
import {
  asFiniteNumberInRange,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";

const XAI_SPEECH_RESPONSE_FORMATS = ["mp3", "wav", "pcm", "mulaw", "alaw"] as const;

export type XaiSpeechResponseFormat = (typeof XAI_SPEECH_RESPONSE_FORMATS)[number];

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

export const XAI_TTS_FALLBACK_VOICES = ["ara", "eve", "leo", "rex", "sal"] as const;

export function normalizeXaiTtsBaseUrl(baseUrl?: string): string {
  return normalizeOptionalString(baseUrl)?.replace(/\/+$/, "") ?? XAI_BASE_URL;
}

export function isValidXaiTtsVoice(voice: string): boolean {
  return normalizeOptionalString(voice) !== undefined;
}

export function normalizeXaiLanguageCode(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "auto" || /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(normalized)) {
    return normalized;
  }
  throw new Error(
    `xAI language must be "auto" or a BCP-47 tag (e.g. "en", "pt-br", "zh-cn"); got: ${normalized}`,
  );
}

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

export function resolveXaiSpeechResponseFormat(
  target: SpeechSynthesisTarget | undefined,
  configuredFormat?: XaiSpeechResponseFormat,
): XaiSpeechResponseFormat {
  // Voice-note consumers may transcode without raw codec/rate metadata.
  // Keep streamed output and buffered fallback self-describing.
  return target === "voice-note" ? "mp3" : (configuredFormat ?? "mp3");
}

export function xaiSpeechResponseFormatToFileExtension(
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

function normalizeXaiSpeechProviderConfig(
  rawConfig: Record<string, unknown>,
): XaiTtsProviderConfig {
  const providers = rawConfig.providers as Record<string, unknown> | undefined;
  const xai = (providers?.xai ?? rawConfig.xai ?? rawConfig) as Record<string, unknown>;
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: xai.apiKey,
      path: "tts.providers.xai.apiKey",
    }),
    baseUrl: normalizeXaiTtsBaseUrl(
      normalizeOptionalString(xai.baseUrl) ??
        normalizeOptionalString(process.env.XAI_BASE_URL) ??
        XAI_BASE_URL,
    ),
    voiceId: normalizeOptionalString(xai.voiceId ?? xai.voice) ?? "eve",
    language: normalizeXaiLanguageCode(xai.language ?? xai.languageCode),
    speed: normalizeXaiSpeechSpeed(xai.speed),
    responseFormat: normalizeXaiSpeechResponseFormat(xai.responseFormat),
  };
}

export function readXaiSpeechProviderConfig(config: SpeechProviderConfig): XaiTtsProviderConfig {
  const normalized = normalizeXaiSpeechProviderConfig({});
  return {
    apiKey: normalizeOptionalString(config.apiKey) ?? normalized.apiKey,
    baseUrl: normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl,
    voiceId: normalizeOptionalString(config.voiceId ?? config.voice) ?? normalized.voiceId,
    language:
      normalizeXaiLanguageCode(config.language ?? config.languageCode) ?? normalized.language,
    speed: normalizeXaiSpeechSpeed(config.speed) ?? normalized.speed,
    responseFormat:
      normalizeXaiSpeechResponseFormat(config.responseFormat) ?? normalized.responseFormat,
  };
}

export function readXaiSpeechOverrides(
  overrides: SpeechProviderOverrides | undefined,
): XaiTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voiceId: normalizeOptionalString(overrides.voiceId ?? overrides.voice),
    language: normalizeXaiLanguageCode(overrides.language),
    speed: normalizeXaiSpeechSpeed(overrides.speed),
  };
}

export function resolveDirectXaiAudioApiKey(configApiKey?: string): string | undefined {
  return normalizeOptionalString(configApiKey) ?? normalizeOptionalString(process.env.XAI_API_KEY);
}

function parseXaiSpeechDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
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

export function createXaiSpeechProviderMetadata(): Omit<
  SpeechProviderPlugin,
  "listVoices" | "synthesize" | "streamSynthesize" | "synthesizeTelephony"
> {
  return {
    id: "xai",
    label: "xAI",
    autoSelectOrder: 25,
    models: [],
    voices: XAI_TTS_FALLBACK_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeXaiSpeechProviderConfig(rawConfig),
    parseDirectiveToken: parseXaiSpeechDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeXaiSpeechProviderConfig(baseTtsConfig);
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
        ...(normalizeOptionalString(talkProviderConfig.baseUrl) === undefined
          ? {}
          : {
              baseUrl: normalizeXaiTtsBaseUrl(normalizeOptionalString(talkProviderConfig.baseUrl)),
            }),
        ...(normalizeOptionalString(talkProviderConfig.voiceId) === undefined
          ? {}
          : { voiceId: normalizeOptionalString(talkProviderConfig.voiceId) }),
        ...(normalizeXaiLanguageCode(
          talkProviderConfig.language ?? talkProviderConfig.languageCode,
        ) === undefined
          ? {}
          : {
              language: normalizeXaiLanguageCode(
                talkProviderConfig.language ?? talkProviderConfig.languageCode,
              ),
            }),
        ...(normalizeXaiSpeechSpeed(talkProviderConfig.speed) === undefined
          ? {}
          : { speed: normalizeXaiSpeechSpeed(talkProviderConfig.speed) }),
        ...(responseFormat === undefined ? {} : { responseFormat }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(normalizeOptionalString(params.voiceId ?? params.voice) === undefined
        ? {}
        : { voiceId: normalizeOptionalString(params.voiceId ?? params.voice) }),
      ...(normalizeXaiLanguageCode(params.language ?? params.languageCode) === undefined
        ? {}
        : { language: normalizeXaiLanguageCode(params.language ?? params.languageCode) }),
      ...(normalizeXaiSpeechSpeed(params.speed) === undefined
        ? {}
        : { speed: normalizeXaiSpeechSpeed(params.speed) }),
    }),
    isConfigured: ({ providerConfig, cfg }) =>
      Boolean(resolveDirectXaiAudioApiKey(readXaiSpeechProviderConfig(providerConfig).apiKey)) ||
      isProviderAuthProfileConfigured({ provider: "xai", cfg }),
  };
}
