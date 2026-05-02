import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  asFiniteNumber,
  asObjectRecord,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";
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
  const body = asObjectRecord(value);
  if (!body || Object.keys(body).length === 0) {
    return undefined;
  }
  return body;
}

function normalizeOpenAIProviderConfig(
  rawConfig: Record<string, unknown>,
): OpenAITtsProviderConfig {
  const raw = resolveOpenAIProviderConfigRecord(rawConfig);
  const extraBody = readExtraBody(raw?.extraBody) ?? readExtraBody(raw?.extra_body);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.openai.apiKey",
    }),
    baseUrl: normalizeOpenAITtsBaseUrl(
      trimToUndefined(raw?.baseUrl) ??
        trimToUndefined(process.env.OPENAI_TTS_BASE_URL) ??
        DEFAULT_OPENAI_BASE_URL,
    ),
    model: trimToUndefined(raw?.model) ?? "gpt-4o-mini-tts",
    voice: trimToUndefined(raw?.voice) ?? "coral",
    speed: asFiniteNumber(raw?.speed),
    instructions: trimToUndefined(raw?.instructions),
    responseFormat: normalizeOpenAISpeechResponseFormat(raw?.responseFormat),
    extraBody,
  };
}

function readOpenAIProviderConfig(config: SpeechProviderConfig): OpenAITtsProviderConfig {
  const normalized = normalizeOpenAIProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    model: trimToUndefined(config.model) ?? normalized.model,
    voice: trimToUndefined(config.voice) ?? normalized.voice,
    speed: asFiniteNumber(config.speed) ?? normalized.speed,
    instructions: trimToUndefined(config.instructions) ?? normalized.instructions,
    responseFormat:
      normalizeOpenAISpeechResponseFormat(config.responseFormat) ?? normalized.responseFormat,
    extraBody: readExtraBody(config.extraBody) ?? readExtraBody(config.extra_body),
  };
}

function readOpenAIOverrides(
  overrides: SpeechProviderOverrides | undefined,
): OpenAITtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model),
    voice: trimToUndefined(overrides.voice),
    speed: asFiniteNumber(overrides.speed),
  };
}

function renderOpenAITtsPersonaInstructions(req: {
  label?: string;
  prompt?: {
    profile?: string;
    scene?: string;
    sampleContext?: string;
    style?: string;
    accent?: string;
    pacing?: string;
    constraints?: string[];
  };
}): string | undefined {
  const prompt = req.prompt;
  if (!prompt) {
    return undefined;
  }
  const lines = [
    req.label ? `Persona: ${req.label}` : undefined,
    prompt.profile ? `Profile: ${prompt.profile}` : undefined,
    prompt.scene ? `Scene: ${prompt.scene}` : undefined,
    prompt.style ? `Style: ${prompt.style}` : undefined,
    prompt.accent ? `Accent: ${prompt.accent}` : undefined,
    prompt.pacing ? `Pacing: ${prompt.pacing}` : undefined,
    prompt.sampleContext ? `Sample context: ${prompt.sampleContext}` : undefined,
    ...(prompt.constraints ?? []).map((constraint) => `Constraint: ${constraint}`),
  ]
    .map((line) => trimToUndefined(line))
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  const baseUrl = trimToUndefined(asObjectRecord(ctx.providerConfig)?.baseUrl);
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
    default:
      return { handled: false };
  }
}

export function buildOpenAISpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    autoSelectOrder: 10,
    models: OPENAI_TTS_MODELS,
    voices: OPENAI_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeOpenAIProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeOpenAIProviderConfig(baseTtsConfig);
      const responseFormat = normalizeOpenAISpeechResponseFormat(talkProviderConfig.responseFormat);
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
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: trimToUndefined(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: trimToUndefined(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asFiniteNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asFiniteNumber(talkProviderConfig.speed) }),
        ...(trimToUndefined(talkProviderConfig.instructions) == null
          ? {}
          : { instructions: trimToUndefined(talkProviderConfig.instructions) }),
        ...(responseFormat == null ? {} : { responseFormat }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voice: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: trimToUndefined(params.modelId) }),
      ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
    }),
    listVoices: async () => OPENAI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ providerConfig }) =>
      Boolean(readOpenAIProviderConfig(providerConfig).apiKey || process.env.OPENAI_API_KEY),
    prepareSynthesis: (ctx) => {
      const config = readOpenAIProviderConfig(ctx.providerConfig);
      if (config.instructions) {
        return undefined;
      }
      const instructions = renderOpenAITtsPersonaInstructions({
        label: ctx.persona?.label ?? ctx.persona?.id,
        prompt: ctx.persona?.prompt,
      });
      return instructions
        ? {
            providerConfig: {
              instructions,
            },
          }
        : undefined;
    },
    synthesize: async (req) => {
      const config = readOpenAIProviderConfig(req.providerConfig);
      const overrides = readOpenAIOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const responseFormat = resolveSpeechResponseFormat(
        config.baseUrl,
        req.target,
        config.responseFormat,
      );
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
      });
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension: responseFormatToFileExtension(responseFormat),
        voiceCompatible: req.target === "voice-note" && responseFormat === "opus",
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readOpenAIProviderConfig(req.providerConfig);
      const overrides = readOpenAIOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const outputFormat = "pcm";
      const sampleRate = 24_000;
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
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
