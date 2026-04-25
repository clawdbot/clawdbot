import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  asObject,
  trimToUndefined,
  type SpeechDirectiveTokenParseContext,
  type SpeechProviderConfig,
  type SpeechProviderOverrides,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { normalizeOpenRouterBaseUrl, OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_TTS_MODEL = "hexgrad/kokoro-82m";
const DEFAULT_OPENROUTER_TTS_VOICE = "af_alloy";
const OPENROUTER_TTS_MODELS = [
  DEFAULT_OPENROUTER_TTS_MODEL,
  "google/gemini-3.1-flash-tts-preview",
  "mistralai/voxtral-mini-tts-2603",
  "elevenlabs/eleven-turbo-v2",
] as const;
const OPENROUTER_TTS_RESPONSE_FORMATS = ["mp3", "pcm"] as const;

type OpenRouterTtsResponseFormat = (typeof OPENROUTER_TTS_RESPONSE_FORMATS)[number];

type OpenRouterTtsProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  voice: string;
  speed?: number;
  responseFormat?: OpenRouterTtsResponseFormat;
  provider?: Record<string, unknown>;
};

type OpenRouterTtsProviderOverrides = {
  model?: string;
  voice?: string;
  speed?: number;
};

function normalizeOpenRouterTtsResponseFormat(
  value: unknown,
): OpenRouterTtsResponseFormat | undefined {
  const next = normalizeOptionalLowercaseString(value);
  if (!next) {
    return undefined;
  }
  if (OPENROUTER_TTS_RESPONSE_FORMATS.some((format) => format === next)) {
    return next as OpenRouterTtsResponseFormat;
  }
  throw new Error(`Invalid OpenRouter speech responseFormat: ${next}`);
}

function normalizeOpenRouterTtsBaseUrl(value: unknown): string {
  return (
    normalizeOpenRouterBaseUrl(trimToUndefined(value) ?? OPENROUTER_BASE_URL) ?? OPENROUTER_BASE_URL
  );
}

function resolveOpenRouterProviderConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.openrouter) ?? asObject(rawConfig.openrouter);
}

function normalizeOpenRouterTtsProviderConfig(
  rawConfig: Record<string, unknown>,
): OpenRouterTtsProviderConfig {
  const raw = resolveOpenRouterProviderConfigRecord(rawConfig);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.openrouter.apiKey",
    }),
    baseUrl:
      trimToUndefined(raw?.baseUrl) == null
        ? undefined
        : normalizeOpenRouterTtsBaseUrl(raw?.baseUrl),
    model: trimToUndefined(raw?.model ?? raw?.modelId) ?? DEFAULT_OPENROUTER_TTS_MODEL,
    voice: trimToUndefined(raw?.voice ?? raw?.voiceId) ?? DEFAULT_OPENROUTER_TTS_VOICE,
    speed: asFiniteNumber(raw?.speed),
    responseFormat: normalizeOpenRouterTtsResponseFormat(raw?.responseFormat),
    provider: asObject(raw?.provider),
  };
}

function readOpenRouterTtsProviderConfig(
  config: SpeechProviderConfig,
): OpenRouterTtsProviderConfig {
  const normalized = normalizeOpenRouterTtsProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl:
      trimToUndefined(config.baseUrl) == null
        ? normalized.baseUrl
        : normalizeOpenRouterTtsBaseUrl(config.baseUrl),
    model: trimToUndefined(config.model ?? config.modelId) ?? normalized.model,
    voice: trimToUndefined(config.voice ?? config.voiceId) ?? normalized.voice,
    speed: asFiniteNumber(config.speed) ?? normalized.speed,
    responseFormat:
      normalizeOpenRouterTtsResponseFormat(config.responseFormat) ?? normalized.responseFormat,
    provider: asObject(config.provider) ?? normalized.provider,
  };
}

function readOpenRouterTtsOverrides(
  overrides: SpeechProviderOverrides | undefined,
): OpenRouterTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model ?? overrides.modelId),
    voice: trimToUndefined(overrides.voice ?? overrides.voiceId),
    speed: asFiniteNumber(overrides.speed),
  };
}

function resolveOpenRouterTtsApiKey(params: {
  cfg?: { models?: { providers?: { openrouter?: { apiKey?: unknown } } } };
  providerConfig: OpenRouterTtsProviderConfig;
}): string | undefined {
  return (
    params.providerConfig.apiKey ??
    normalizeResolvedSecretInputString({
      value: params.cfg?.models?.providers?.openrouter?.apiKey,
      path: "models.providers.openrouter.apiKey",
    }) ??
    trimToUndefined(process.env.OPENROUTER_API_KEY)
  );
}

function resolveOpenRouterTtsBaseUrl(params: {
  cfg?: { models?: { providers?: { openrouter?: { baseUrl?: unknown } } } };
  providerConfig: OpenRouterTtsProviderConfig;
}): string {
  return normalizeOpenRouterTtsBaseUrl(
    params.providerConfig.baseUrl ??
      trimToUndefined(params.cfg?.models?.providers?.openrouter?.baseUrl) ??
      OPENROUTER_BASE_URL,
  );
}

function resolveOpenRouterTtsResponseFormat(
  configuredFormat?: OpenRouterTtsResponseFormat,
): OpenRouterTtsResponseFormat {
  if (configuredFormat) {
    return configuredFormat;
  }
  return "mp3";
}

function responseFormatToFileExtension(format: OpenRouterTtsResponseFormat): ".mp3" | ".pcm" {
  return format === "pcm" ? ".pcm" : ".mp3";
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
} {
  switch (ctx.key) {
    case "voice":
    case "voice_id":
    case "voiceid":
    case "openrouter_voice":
    case "openroutervoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    case "model":
    case "model_id":
    case "modelid":
    case "openrouter_model":
    case "openroutermodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    default:
      return { handled: false };
  }
}

export function buildOpenRouterSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openrouter",
    label: "OpenRouter",
    autoSelectOrder: 35,
    models: OPENROUTER_TTS_MODELS,
    voices: [DEFAULT_OPENROUTER_TTS_VOICE],
    resolveConfig: ({ rawConfig }) => normalizeOpenRouterTtsProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeOpenRouterTtsProviderConfig(baseTtsConfig);
      const responseFormat = normalizeOpenRouterTtsResponseFormat(
        talkProviderConfig.responseFormat,
      );
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.openrouter.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeOpenRouterTtsBaseUrl(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: trimToUndefined(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asFiniteNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asFiniteNumber(talkProviderConfig.speed) }),
        ...(responseFormat == null ? {} : { responseFormat }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId ?? params.voice) == null
        ? {}
        : { voice: trimToUndefined(params.voiceId ?? params.voice) }),
      ...(trimToUndefined(params.modelId ?? params.model) == null
        ? {}
        : { model: trimToUndefined(params.modelId ?? params.model) }),
      ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
    }),
    listVoices: async () => [
      { id: DEFAULT_OPENROUTER_TTS_VOICE, name: DEFAULT_OPENROUTER_TTS_VOICE },
    ],
    isConfigured: ({ cfg, providerConfig }) => {
      const config = readOpenRouterTtsProviderConfig(providerConfig);
      return Boolean(resolveOpenRouterTtsApiKey({ cfg, providerConfig: config }));
    },
    synthesize: async (req) => {
      const config = readOpenRouterTtsProviderConfig(req.providerConfig);
      const overrides = readOpenRouterTtsOverrides(req.providerOverrides);
      const apiKey = resolveOpenRouterTtsApiKey({ cfg: req.cfg, providerConfig: config });
      if (!apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const baseUrl = resolveOpenRouterTtsBaseUrl({ cfg: req.cfg, providerConfig: config });
      const responseFormat = resolveOpenRouterTtsResponseFormat(config.responseFormat);
      const speed = overrides.speed ?? config.speed;
      const { allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
        baseUrl,
        defaultBaseUrl: OPENROUTER_BASE_URL,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw.ai",
          "X-OpenRouter-Title": "OpenClaw",
        },
        provider: "openrouter",
        capability: "audio",
        transport: "http",
      });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/audio/speech`,
        headers,
        body: {
          model: overrides.model ?? config.model,
          input: req.text,
          voice: overrides.voice ?? config.voice,
          response_format: responseFormat,
          ...(speed == null ? {} : { speed }),
          ...(config.provider == null ? {} : { provider: config.provider }),
        },
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter TTS API error");
        return {
          audioBuffer: Buffer.from(await response.arrayBuffer()),
          outputFormat: responseFormat,
          fileExtension: responseFormatToFileExtension(responseFormat),
          voiceCompatible: responseFormat === "mp3",
        };
      } finally {
        await release();
      }
    },
  };
}
