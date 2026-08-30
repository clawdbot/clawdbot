// Gandr provider module implements model/runtime integration.
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { resolveSpeechProviderApiKey, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_GANDR_MODEL_ID,
  DEFAULT_GANDR_VOICE_ID,
  GANDR_PCM_SAMPLE_RATE_HERTZ,
  GANDR_TTS_MODELS,
  type GandrResponseFormat,
  gandrTTS,
  listGandrVoices,
  normalizeGandrBaseUrl,
} from "./tts.js";

type GandrProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  responseFormat: GandrAttachmentFormat;
};

// Telephony always uses PCM; attachments choose between the compressed formats.
type GandrAttachmentFormat = Extract<GandrResponseFormat, "mp3" | "wav">;

type GandrSynthesisRequest = {
  text: string;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
  responseFormat: GandrResponseFormat;
};

function normalizeGandrResponseFormat(value: unknown): GandrAttachmentFormat | undefined {
  return value === "mp3" || value === "wav" ? value : undefined;
}

function normalizeGandrProviderConfig(rawConfig: Record<string, unknown>): GandrProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.gandr) ?? asOptionalRecord(rawConfig.gandr);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.gandr.apiKey",
    }),
    baseUrl: normalizeGandrBaseUrl(trimToUndefined(raw?.baseUrl)),
    voiceId: trimToUndefined(raw?.voiceId) ?? DEFAULT_GANDR_VOICE_ID,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_GANDR_MODEL_ID,
    responseFormat: normalizeGandrResponseFormat(raw?.responseFormat) ?? "mp3",
  };
}

function readGandrProviderConfig(config: SpeechProviderConfig): GandrProviderConfig {
  const defaults = normalizeGandrProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: normalizeGandrBaseUrl(trimToUndefined(config.baseUrl) ?? defaults.baseUrl),
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    modelId: trimToUndefined(config.modelId) ?? defaults.modelId,
    responseFormat: normalizeGandrResponseFormat(config.responseFormat) ?? defaults.responseFormat,
  };
}

function resolveGandrApiKey(primary?: string, fallback?: string): string | undefined {
  return resolveSpeechProviderApiKey(primary, fallback, process.env.GANDR_API_KEY);
}

function readGandrOverrides(overrides: SpeechProviderOverrides | undefined) {
  return {
    voiceId: trimToUndefined(overrides?.voiceId ?? overrides?.voice),
    modelId: trimToUndefined(overrides?.modelId ?? overrides?.model),
  };
}

async function synthesizeGandr(req: GandrSynthesisRequest): Promise<Buffer> {
  const config = readGandrProviderConfig(req.providerConfig);
  const overrides = readGandrOverrides(req.providerOverrides);
  const apiKey = resolveGandrApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error("Gandr API key missing");
  }

  return gandrTTS({
    text: req.text,
    apiKey,
    baseUrl: config.baseUrl,
    voiceId: overrides.voiceId ?? config.voiceId,
    modelId: overrides.modelId ?? config.modelId,
    responseFormat: req.responseFormat,
    timeoutMs: req.timeoutMs,
  });
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
    case "gandr_voice":
    case "gandrvoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voiceId: ctx.value } };
    case "model":
    case "modelid":
    case "model_id":
    case "gandr_model":
    case "gandrmodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { modelId: ctx.value } };
    default:
      return { handled: false };
  }
}

export function buildGandrSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "gandr",
    label: "Gandr",
    autoSelectOrder: 31,
    defaultModel: DEFAULT_GANDR_MODEL_ID,
    models: GANDR_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeGandrProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeGandrProviderConfig(baseTtsConfig);
      const resolvedApiKey =
        talkProviderConfig.apiKey === undefined
          ? undefined
          : normalizeResolvedSecretInputString({
              value: talkProviderConfig.apiKey,
              path: "talk.providers.gandr.apiKey",
            });
      return {
        ...base,
        ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeGandrBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { modelId: trimToUndefined(talkProviderConfig.modelId) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { modelId: trimToUndefined(params.modelId) }),
    }),
    listVoices: async () => listGandrVoices(),
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveGandrApiKey(readGandrProviderConfig(providerConfig).apiKey)),
    synthesize: async (req) => {
      const responseFormat = readGandrProviderConfig(req.providerConfig).responseFormat;
      const audioBuffer = await synthesizeGandr({
        ...req,
        responseFormat,
      });

      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension: `.${responseFormat}`,
        voiceCompatible: false,
      };
    },
    synthesizeTelephony: async (req) => {
      const audioBuffer = await synthesizeGandr({
        ...req,
        responseFormat: "pcm",
      });

      return { audioBuffer, outputFormat: "pcm", sampleRate: GANDR_PCM_SAMPLE_RATE_HERTZ };
    },
  };
}
