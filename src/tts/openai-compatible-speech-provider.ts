import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { asFiniteNumber, asObject, trimToUndefined } from "../agents/provider-http-errors.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
} from "./provider-types.js";

type OpenAiCompatibleSpeechProviderBaseConfig = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  voice: string;
  speed?: number;
  responseFormat?: string;
};

export type OpenAiCompatibleSpeechProviderConfig<
  ExtraConfig extends Record<string, unknown> = Record<string, never>,
> = OpenAiCompatibleSpeechProviderBaseConfig & ExtraConfig;

export type OpenAiCompatibleSpeechProviderBaseUrlPolicy =
  | { kind: "trim-trailing-slash" }
  | { kind: "canonical"; aliases?: readonly string[]; allowCustom?: boolean };

export type OpenAiCompatibleSpeechProviderExtraJsonBodyField<
  ExtraConfig extends Record<string, unknown>,
> = {
  configKey: Extract<keyof ExtraConfig, string>;
  requestKey?: string;
};

export type OpenAiCompatibleSpeechProviderOptions<
  ExtraConfig extends Record<string, unknown> = Record<string, never>,
> = {
  id: string;
  label: string;
  autoSelectOrder: number;
  models: readonly string[];
  voices: readonly string[];
  defaultModel: string;
  defaultVoice: string;
  defaultBaseUrl: string;
  envKey: string;
  responseFormats: readonly string[];
  defaultResponseFormat: string;
  voiceCompatibleResponseFormats: readonly string[];
  baseUrlPolicy?: OpenAiCompatibleSpeechProviderBaseUrlPolicy;
  normalizeModel?: (value: string | undefined, fallback: string) => string;
  configKey?: string;
  extraHeaders?: Record<string, string>;
  readExtraConfig?: (raw: Record<string, unknown> | undefined) => ExtraConfig;
  extraJsonBodyFields?: readonly OpenAiCompatibleSpeechProviderExtraJsonBodyField<ExtraConfig>[];
  apiErrorLabel?: string;
  missingApiKeyError?: string;
};

type ModelProviderConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
};

function normalizeResponseFormat(params: {
  providerLabel: string;
  responseFormats: readonly string[];
  value: unknown;
}): string | undefined {
  const next = normalizeOptionalLowercaseString(params.value);
  if (!next) {
    return undefined;
  }
  if (params.responseFormats.includes(next)) {
    return next;
  }
  throw new Error(`Invalid ${params.providerLabel} speech responseFormat: ${next}`);
}

function responseFormatToFileExtension(format: string): `.${string}` {
  return `.${format}`;
}

function trimTrailingBaseUrl(value: unknown, fallback: string): string {
  return (trimToUndefined(value) ?? fallback).replace(/\/+$/u, "");
}

function normalizeBaseUrl(params: {
  value: unknown;
  fallback: string;
  policy?: OpenAiCompatibleSpeechProviderBaseUrlPolicy;
}): string {
  const normalized = trimTrailingBaseUrl(params.value, params.fallback);
  if (params.policy?.kind !== "canonical") {
    return normalized;
  }
  const canonical = trimTrailingBaseUrl(params.fallback, params.fallback);
  const aliases = new Set(
    [canonical, ...(params.policy.aliases ?? [])].map((entry) =>
      trimTrailingBaseUrl(entry, canonical),
    ),
  );
  return aliases.has(normalized) || !params.policy.allowCustom ? canonical : normalized;
}

function resolveProviderConfigRecord(
  rawConfig: Record<string, unknown>,
  providerConfigKey: string,
): Record<string, unknown> | undefined {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.[providerConfigKey]) ?? asObject(rawConfig[providerConfigKey]);
}

function readModelProviderConfig(
  cfg: unknown,
  providerConfigKey: string,
): ModelProviderConfig | undefined {
  const root = asObject(cfg);
  const models = asObject(root?.models);
  const providers = asObject(models?.providers);
  return asObject(providers?.[providerConfigKey]);
}

function readSpeechOverrides(overrides: SpeechProviderOverrides | undefined): {
  model?: string;
  voice?: string;
  speed?: number;
} {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model ?? overrides.modelId),
    voice: trimToUndefined(overrides.voice ?? overrides.voiceId),
    speed: asFiniteNumber(overrides.speed),
  };
}

function parseDirectiveToken(
  ctx: SpeechDirectiveTokenParseContext,
  providerConfigKey: string,
): { handled: boolean; overrides?: SpeechProviderOverrides } {
  const compactProviderKey = providerConfigKey.replace(/[^a-z0-9]+/giu, "").toLowerCase();
  switch (ctx.key) {
    case "voice":
    case "voice_id":
    case "voiceid":
    case `${providerConfigKey}_voice`:
    case `${compactProviderKey}voice`:
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    case "model":
    case "model_id":
    case "modelid":
    case `${providerConfigKey}_model`:
    case `${compactProviderKey}model`:
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    default:
      return { handled: false };
  }
}

function buildExtraJsonBodyFields<ExtraConfig extends Record<string, unknown>>(
  config: OpenAiCompatibleSpeechProviderConfig<ExtraConfig>,
  fields: readonly OpenAiCompatibleSpeechProviderExtraJsonBodyField<ExtraConfig>[] | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields ?? []) {
    const value = config[field.configKey];
    if (value != null) {
      body[field.requestKey ?? field.configKey] = value;
    }
  }
  return body;
}

export function createOpenAiCompatibleSpeechProvider<
  ExtraConfig extends Record<string, unknown> = Record<string, never>,
>(options: OpenAiCompatibleSpeechProviderOptions<ExtraConfig>): SpeechProviderPlugin {
  const providerConfigKey = options.configKey ?? options.id;
  const normalizeModel =
    options.normalizeModel ?? ((value, fallback) => trimToUndefined(value) ?? fallback);
  const readExtraConfig = options.readExtraConfig ?? (() => ({}) as ExtraConfig);

  function normalizeConfig(
    rawConfig: Record<string, unknown>,
  ): OpenAiCompatibleSpeechProviderConfig<ExtraConfig> {
    const raw = resolveProviderConfigRecord(rawConfig, providerConfigKey);
    return {
      apiKey: normalizeResolvedSecretInputString({
        value: raw?.apiKey,
        path: `messages.tts.providers.${providerConfigKey}.apiKey`,
      }),
      baseUrl:
        trimToUndefined(raw?.baseUrl) == null
          ? undefined
          : normalizeBaseUrl({
              value: raw?.baseUrl,
              fallback: options.defaultBaseUrl,
              policy: options.baseUrlPolicy,
            }),
      model: normalizeModel(trimToUndefined(raw?.model ?? raw?.modelId), options.defaultModel),
      voice: trimToUndefined(raw?.voice ?? raw?.voiceId) ?? options.defaultVoice,
      speed: asFiniteNumber(raw?.speed),
      responseFormat: normalizeResponseFormat({
        providerLabel: options.label,
        responseFormats: options.responseFormats,
        value: raw?.responseFormat,
      }),
      ...readExtraConfig(raw),
    };
  }

  function readProviderConfig(
    config: SpeechProviderConfig,
  ): OpenAiCompatibleSpeechProviderConfig<ExtraConfig> {
    const normalized = normalizeConfig({});
    return {
      apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
      baseUrl:
        trimToUndefined(config.baseUrl) == null
          ? normalized.baseUrl
          : normalizeBaseUrl({
              value: config.baseUrl,
              fallback: options.defaultBaseUrl,
              policy: options.baseUrlPolicy,
            }),
      model: normalizeModel(trimToUndefined(config.model ?? config.modelId), normalized.model),
      voice: trimToUndefined(config.voice ?? config.voiceId) ?? normalized.voice,
      speed: asFiniteNumber(config.speed) ?? normalized.speed,
      responseFormat:
        normalizeResponseFormat({
          providerLabel: options.label,
          responseFormats: options.responseFormats,
          value: config.responseFormat,
        }) ?? normalized.responseFormat,
      ...readExtraConfig(config),
    };
  }

  function resolveApiKey(params: {
    cfg?: unknown;
    providerConfig: OpenAiCompatibleSpeechProviderConfig<ExtraConfig>;
  }): string | undefined {
    return (
      params.providerConfig.apiKey ??
      normalizeResolvedSecretInputString({
        value: readModelProviderConfig(params.cfg, providerConfigKey)?.apiKey,
        path: `models.providers.${providerConfigKey}.apiKey`,
      }) ??
      trimToUndefined(process.env[options.envKey])
    );
  }

  function resolveBaseUrl(params: {
    cfg?: unknown;
    providerConfig: OpenAiCompatibleSpeechProviderConfig<ExtraConfig>;
  }): string {
    return normalizeBaseUrl({
      value:
        params.providerConfig.baseUrl ??
        trimToUndefined(readModelProviderConfig(params.cfg, providerConfigKey)?.baseUrl),
      fallback: options.defaultBaseUrl,
      policy: options.baseUrlPolicy,
    });
  }

  return {
    id: options.id,
    label: options.label,
    autoSelectOrder: options.autoSelectOrder,
    models: [...options.models],
    voices: [...options.voices],
    resolveConfig: ({ rawConfig }) => normalizeConfig(rawConfig),
    parseDirectiveToken: (ctx) => parseDirectiveToken(ctx, providerConfigKey),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeConfig(baseTtsConfig);
      const responseFormat = normalizeResponseFormat({
        providerLabel: options.label,
        responseFormats: options.responseFormats,
        value: talkProviderConfig.responseFormat,
      });
      const next: OpenAiCompatibleSpeechProviderConfig<ExtraConfig> = { ...base };
      if (talkProviderConfig.apiKey !== undefined) {
        next.apiKey = normalizeResolvedSecretInputString({
          value: talkProviderConfig.apiKey,
          path: `talk.providers.${providerConfigKey}.apiKey`,
        });
      }
      const baseUrl = trimToUndefined(talkProviderConfig.baseUrl);
      if (baseUrl !== undefined) {
        next.baseUrl = normalizeBaseUrl({
          value: baseUrl,
          fallback: options.defaultBaseUrl,
          policy: options.baseUrlPolicy,
        });
      }
      const modelId = trimToUndefined(talkProviderConfig.modelId);
      if (modelId !== undefined) {
        next.model = normalizeModel(modelId, options.defaultModel);
      }
      const voiceId = trimToUndefined(talkProviderConfig.voiceId);
      if (voiceId !== undefined) {
        next.voice = voiceId;
      }
      const speed = asFiniteNumber(talkProviderConfig.speed);
      if (speed !== undefined) {
        next.speed = speed;
      }
      if (responseFormat !== undefined) {
        next.responseFormat = responseFormat;
      }
      return next;
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
    listVoices: async () => options.voices.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(resolveApiKey({ cfg, providerConfig: readProviderConfig(providerConfig) })),
    synthesize: async (req) => {
      const config = readProviderConfig(req.providerConfig);
      const overrides = readSpeechOverrides(req.providerOverrides);
      const apiKey = resolveApiKey({ cfg: req.cfg, providerConfig: config });
      if (!apiKey) {
        throw new Error(options.missingApiKeyError ?? `${options.label} API key missing`);
      }

      const baseUrl = resolveBaseUrl({ cfg: req.cfg, providerConfig: config });
      const responseFormat = config.responseFormat ?? options.defaultResponseFormat;
      const speed = overrides.speed ?? config.speed;
      const { allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
        baseUrl,
        defaultBaseUrl: options.defaultBaseUrl,
        allowPrivateNetwork: false,
        defaultHeaders: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...options.extraHeaders,
        },
        provider: options.id,
        capability: "audio",
        transport: "http",
      });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/audio/speech`,
        headers,
        body: {
          model: normalizeModel(overrides.model ?? config.model, options.defaultModel),
          input: req.text,
          voice: overrides.voice ?? config.voice,
          response_format: responseFormat,
          ...(speed == null ? {} : { speed }),
          ...buildExtraJsonBodyFields(config, options.extraJsonBodyFields),
        },
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(
          response,
          options.apiErrorLabel ?? `${options.label} TTS API error`,
        );
        return {
          audioBuffer: Buffer.from(await response.arrayBuffer()),
          outputFormat: responseFormat,
          fileExtension: responseFormatToFileExtension(responseFormat),
          voiceCompatible: options.voiceCompatibleResponseFormats.includes(responseFormat),
        };
      } finally {
        await release();
      }
    },
  };
}
