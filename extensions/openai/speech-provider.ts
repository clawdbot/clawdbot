// Openai provider module implements model/runtime integration.
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { parseSpeechDirectiveNumberOverride } from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenAIProviderConfigRecord } from "./realtime-provider-shared.js";
import {
  DEFAULT_OPENAI_BASE_URL,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  normalizeOpenAITtsBaseUrl,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  openaiTTS,
} from "./tts.js";

const OPENAI_SPEECH_RESPONSE_FORMATS = ["mp3", "opus", "wav"] as const;

type OpenAiSpeechResponseFormat = (typeof OPENAI_SPEECH_RESPONSE_FORMATS)[number];

type OpenAITtsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
  instructions?: string;
  responseFormat?: OpenAiSpeechResponseFormat;
  extraBody?: Record<string, unknown>;
};

type OpenAITtsProviderOverrides = {
  model?: string;
  voice?: string;
  speed?: number;
};

function resolveOpenAISpeechApiKey(config: OpenAITtsProviderConfig): string | undefined {
  return (
    normalizeOptionalString(config.apiKey) ?? normalizeOptionalString(process.env.OPENAI_API_KEY)
  );
}

function normalizeOpenAISpeechResponseFormat(
  value: unknown,
): OpenAiSpeechResponseFormat | undefined {
  const next = normalizeOptionalLowercaseString(value);
  if (!next) {
    return undefined;
  }
  if (
    OPENAI_SPEECH_RESPONSE_FORMATS.includes(next as (typeof OPENAI_SPEECH_RESPONSE_FORMATS)[number])
  ) {
    return next as OpenAiSpeechResponseFormat;
  }
  throw new Error(`Invalid OpenAI speech responseFormat: ${next}`);
}

function isGroqSpeechBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    return hostname === "groq.com" || hostname.endsWith(".groq.com");
  } catch {
    return false;
  }
}

function resolveSpeechResponseFormat(
  baseUrl: string,
  target: "audio-file" | "voice-note" | "telephony",
  configuredFormat?: OpenAiSpeechResponseFormat,
): OpenAiSpeechResponseFormat {
  if (configuredFormat) {
    return configuredFormat;
  }
  if (isGroqSpeechBaseUrl(baseUrl)) {
    return "wav";
  }
  return target === "voice-note" ? "opus" : "mp3";
}

function responseFormatToFileExtension(
  format: OpenAiSpeechResponseFormat,
): ".mp3" | ".opus" | ".wav" {
  switch (format) {
    case "opus":
      return ".opus";
    case "wav":
      return ".wav";
    default:
      return ".mp3";
  }
}

function readExtraBody(value: unknown): Record<string, unknown> | undefined {
  const body = asOptionalRecord(value);
  if (!body || Object.keys(body).length === 0) {
    return undefined;
  }
  return body;
}

function normalizeOpenAISpeechSpeed(value: unknown, baseUrl?: string): number | undefined {
  const speed = asFiniteNumber(value);
  if (speed === undefined) {
    return undefined;
  }
  if (baseUrl !== undefined && normalizeOpenAITtsBaseUrl(baseUrl) !== DEFAULT_OPENAI_BASE_URL) {
    return speed;
  }
  return speed >= 0.25 && speed <= 4 ? speed : undefined;
}

function normalizeOpenAIProviderConfig(
  rawConfig: Record<string, unknown>,
): OpenAITtsProviderConfig {
  const raw = resolveOpenAIProviderConfigRecord(rawConfig);
  const extraBody = readExtraBody(raw?.extraBody) ?? readExtraBody(raw?.extra_body);
  const baseUrl = normalizeOpenAITtsBaseUrl(
    normalizeOptionalString(raw?.baseUrl) ??
      normalizeOptionalString(process.env.OPENAI_TTS_BASE_URL) ??
      DEFAULT_OPENAI_BASE_URL,
  );
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.openai.apiKey",
    }),
    baseUrl,
    model: normalizeOptionalString(raw?.model) ?? "gpt-4o-mini-tts",
    voice: normalizeOptionalString(raw?.voice) ?? "coral",
    speed: normalizeOpenAISpeechSpeed(raw?.speed, baseUrl),
    instructions: normalizeOptionalString(raw?.instructions),
    responseFormat: normalizeOpenAISpeechResponseFormat(raw?.responseFormat),
    extraBody,
  };
}

function readOpenAIProviderConfig(config: SpeechProviderConfig): OpenAITtsProviderConfig {
  const normalized = normalizeOpenAIProviderConfig({});
  return {
    apiKey: normalizeOptionalString(config.apiKey) ?? normalized.apiKey,
    baseUrl: normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl,
    model: normalizeOptionalString(config.model) ?? normalized.model,
    voice: normalizeOptionalString(config.voice) ?? normalized.voice,
    speed:
      normalizeOpenAISpeechSpeed(
        config.speed,
        normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl,
      ) ?? normalized.speed,
    instructions: normalizeOptionalString(config.instructions) ?? normalized.instructions,
    responseFormat:
      normalizeOpenAISpeechResponseFormat(config.responseFormat) ?? normalized.responseFormat,
    extraBody: readExtraBody(config.extraBody) ?? readExtraBody(config.extra_body),
  };
}

function readOpenAIOverrides(
  overrides: SpeechProviderOverrides | undefined,
  baseUrl: string,
): OpenAITtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: normalizeOptionalString(overrides.model),
    voice: normalizeOptionalString(overrides.voice),
    speed: normalizeOpenAISpeechSpeed(overrides.speed, baseUrl),
  };
}

function isCustomOpenAITtsBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl !== undefined) {
    return normalizeOpenAITtsBaseUrl(baseUrl) !== DEFAULT_OPENAI_BASE_URL;
  }
  return normalizeOpenAITtsBaseUrl(process.env.OPENAI_TTS_BASE_URL) !== DEFAULT_OPENAI_BASE_URL;
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  const baseUrl = normalizeOptionalString(asOptionalRecord(ctx.providerConfig)?.baseUrl);
  switch (ctx.key) {
    case "voice":
    case "openai_voice":
    case "openaivoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      if (!isValidOpenAIVoice(ctx.value, baseUrl)) {
        return { handled: true, warnings: [`invalid OpenAI voice "${ctx.value}"`] };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    case "model":
    case "openai_model":
    case "openaimodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      if (!isValidOpenAIModel(ctx.value, baseUrl)) {
        return { handled: false };
      }
      return { handled: true, overrides: { model: ctx.value } };
    case "speed":
    case "openai_speed":
    case "openaispeed": {
      const customBaseUrl = isCustomOpenAITtsBaseUrl(baseUrl);
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "speed",
        range: customBaseUrl ? {} : { min: 0.25, max: 4 },
        warning: (value) =>
          customBaseUrl
            ? `invalid OpenAI-compatible speed "${value}"`
            : `invalid OpenAI speed "${value}" (0.25-4.0)`,
      });
    }
    default:
      return { handled: false };
  }
}

export function buildOpenAISpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    autoSelectOrder: 10,
    defaultModel: OPENAI_TTS_MODELS[0],
    models: OPENAI_TTS_MODELS,
    voices: OPENAI_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeOpenAIProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeOpenAIProviderConfig(baseTtsConfig);
      const responseFormat = normalizeOpenAISpeechResponseFormat(talkProviderConfig.responseFormat);
      const baseUrl = normalizeOptionalString(talkProviderConfig.baseUrl) ?? base.baseUrl;
      const speed = normalizeOpenAISpeechSpeed(talkProviderConfig.speed, baseUrl);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.openai.apiKey",
              }),
            }),
        ...(normalizeOptionalString(talkProviderConfig.baseUrl) == null ? {} : { baseUrl }),
        ...(normalizeOptionalString(talkProviderConfig.modelId) == null
          ? {}
          : { model: normalizeOptionalString(talkProviderConfig.modelId) }),
        ...(normalizeOptionalString(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: normalizeOptionalString(talkProviderConfig.voiceId) }),
        ...(speed == null ? {} : { speed }),
        ...(normalizeOptionalString(talkProviderConfig.instructions) == null
          ? {}
          : { instructions: normalizeOptionalString(talkProviderConfig.instructions) }),
        ...(responseFormat == null ? {} : { responseFormat }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(normalizeOptionalString(params.voiceId) == null
        ? {}
        : { voice: normalizeOptionalString(params.voiceId) }),
      ...(normalizeOptionalString(params.modelId) == null
        ? {}
        : { model: normalizeOptionalString(params.modelId) }),
      ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
    }),
    listVoices: async () => OPENAI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveOpenAISpeechApiKey(readOpenAIProviderConfig(providerConfig))),
    synthesize: async (req) => {
      const config = readOpenAIProviderConfig(req.providerConfig);
      const overrides = readOpenAIOverrides(req.providerOverrides, config.baseUrl);
      const apiKey = resolveOpenAISpeechApiKey(config);
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const responseFormat = resolveSpeechResponseFormat(
        config.baseUrl,
        req.target,
        config.responseFormat,
      );
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      const audioBuffer = await openaiTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: overrides.model ?? config.model,
        voice: overrides.voice ?? config.voice,
        speed: overrides.speed ?? config.speed,
        instructions: config.instructions,
        responseFormat,
        extraBody: config.extraBody,
        timeoutMs: req.timeoutMs,
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
      });
      const fileExtension = responseFormatToFileExtension(responseFormat);
      const { isVoiceMessageCompatibleAudio } = await import("openclaw/plugin-sdk/media-runtime");
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension,
        voiceCompatible:
          req.target === "voice-note" &&
          isVoiceMessageCompatibleAudio({ fileName: `speech${fileExtension}` }),
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readOpenAIProviderConfig(req.providerConfig);
      const overrides = readOpenAIOverrides(req.providerOverrides, config.baseUrl);
      const apiKey = resolveOpenAISpeechApiKey(config);
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const outputFormat = "pcm";
      const sampleRate = 24_000;
      const { resolveGeneratedMediaMaxBytes } =
        await import("openclaw/plugin-sdk/media-generation-runtime");
      const audioBuffer = await openaiTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: overrides.model ?? config.model,
        voice: overrides.voice ?? config.voice,
        speed: overrides.speed ?? config.speed,
        instructions: config.instructions,
        responseFormat: outputFormat,
        extraBody: config.extraBody,
        timeoutMs: req.timeoutMs,
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "audio"),
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
