// Gateway RPC handlers for Talk voice, transcription, and speech synthesis surfaces.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  missingScopeErrorShape,
  type TalkSpeakParams,
  validateTalkCatalogParams,
  validateTalkConfigParams,
  validateTalkModeParams,
  validateTalkSpeakParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  withSpeakerSelectionCompat,
  withSpeakerSelectionFallbackCompat,
} from "../../../packages/speech-core/speaker.js";
import {
  CODE_HEAVY_SPOKEN_FALLBACK,
  isCodeHeavySpeechText,
} from "../../../packages/speech-core/src/speech-text.js";
import { getVoiceProviderConfig } from "../../../packages/speech-core/voice-models.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  buildTalkConfigResponse,
  normalizeTalkSection,
  resolveActiveTalkProviderConfig,
} from "../../config/talk.js";
import type {
  TalkConfigResponse,
  TalkProviderConfig,
  TalkRealtimeConfig,
} from "../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../config/types.js";
import { resolveProviderRawConfig } from "../../plugin-sdk/provider-selection-runtime.js";
import { canonicalizeRealtimeTranscriptionProviderId } from "../../realtime-transcription/provider-registry.js";
import {
  canonicalizeRealtimeVoiceProviderId,
  listRealtimeVoiceProviders,
} from "../../talk/provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../tts/provider-registry.js";
import {
  getResolvedSpeechProviderConfig,
  resolveTtsConfig,
  synthesizeSpeech,
  type TtsDirectiveOverrides,
} from "../../tts/tts.js";
import { ADMIN_SCOPE, READ_SCOPE, TALK_SECRETS_SCOPE } from "../operator-scopes.js";
import { resolveConfiguredSecretInputString } from "../resolve-configured-secret-input-string.js";
import { formatForLog } from "../ws-log.js";
import { inferSpeechMimeType } from "./speech-mime.js";
import { talkClientHandlers } from "./talk-client.js";
import { talkSessionHandlers } from "./talk-session.js";
import {
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  configuredOrFalse,
  listTalkTranscriptionProviders,
  resolveConfiguredRealtimeTranscriptionProvider,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "method_unavailable"
  | "synthesis_failed"
  | "invalid_audio_result";

type TalkSpeakErrorDetails = {
  reason: TalkSpeakReason;
  fallbackEligible: boolean;
};

function resolveCatalogProviderSelection(
  configuredProvider: string | undefined,
  resolveAutomaticProvider: () => string,
): { activeProvider?: string; ready: boolean } {
  // Provider priority belongs to the runtime resolver; catalog consumers must not infer it from row order.
  try {
    const resolvedProvider = resolveAutomaticProvider();
    return {
      activeProvider: resolvedProvider,
      ready: true,
    };
  } catch {
    return {
      ...(configuredProvider ? { activeProvider: configuredProvider } : {}),
      ready: false,
    };
  }
}

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asOptionalRecord(value);
  if (!record) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue === "string") {
      next[key] = entryValue;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAliasKey(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = asStringRecord(providerConfig.voiceAliases);
  if (!aliases) {
    return requested;
  }
  const normalizedRequested = normalizeAliasKey(requested);
  for (const [alias, voiceId] of Object.entries(aliases)) {
    if (normalizeAliasKey(alias) === normalizedRequested) {
      return voiceId;
    }
  }
  return requested;
}

function withTalkBaseTtsSpeakerSelectionCompat(
  baseTts: Record<string, unknown>,
): Record<string, unknown> {
  const next = withSpeakerSelectionCompat(baseTts);
  const providers = asOptionalRecord(baseTts.providers);
  if (providers) {
    next.providers = Object.fromEntries(
      Object.entries(providers).map(([providerId, providerConfig]) => [
        providerId,
        withSpeakerSelectionCompat(asOptionalRecord(providerConfig) ?? {}),
      ]),
    );
  }
  for (const [key, value] of Object.entries(baseTts)) {
    if (key === "providers") {
      continue;
    }
    const record = asOptionalRecord(value);
    if (record) {
      next[key] = withSpeakerSelectionCompat(record);
    }
  }
  return next;
}

function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string; reason: TalkSpeakReason } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
  if (!resolved || !provider) {
    return {
      error: "talk.speak unavailable: talk provider not configured",
      reason: "talk_unconfigured",
    };
  }

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const baseTts = withTalkBaseTtsSpeakerSelectionCompat(
    asOptionalRecord(config.messages?.tts) ?? {},
  ) as TtsConfig;
  const providerConfig = withSpeakerSelectionFallbackCompat(resolved.config);
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      baseTtsConfig: baseTts as Record<string, unknown>,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      ...((asOptionalRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      messages: {
        ...config.messages,
        tts: talkTts,
      },
    },
  };
}

function buildTalkCatalog(config: OpenClawConfig) {
  const ttsConfig = resolveTtsConfig(config);
  const talkResolved = resolveActiveTalkProviderConfig(config.talk);
  const activeSpeechProvider = canonicalizeSpeechProviderId(talkResolved?.provider, config);
  const transcriptionConfig = buildTalkTranscriptionConfig(config);
  const transcriptionSelection = resolveCatalogProviderSelection(
    canonicalizeRealtimeTranscriptionProviderId(transcriptionConfig.provider, config),
    () =>
      resolveConfiguredRealtimeTranscriptionProvider({
        config,
        configuredProviderId: transcriptionConfig.provider,
        providerConfigs: transcriptionConfig.providers,
        defaultModel: transcriptionConfig.model,
      }).provider.id,
  );
  const activeTranscriptionProvider = transcriptionSelection.activeProvider;
  const realtimeConfig = buildTalkRealtimeConfig(config);
  const realtimeSelection = resolveCatalogProviderSelection(
    canonicalizeRealtimeVoiceProviderId(realtimeConfig.provider, config),
    () =>
      resolveConfiguredRealtimeVoiceProvider({
        cfg: config,
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        defaultModel: realtimeConfig.model,
      }).provider.id,
  );
  const activeRealtimeProvider = realtimeSelection.activeProvider;

  return {
    modes: ["realtime", "stt-tts", "transcription"],
    transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
    brains: ["agent-consult", "direct-tools", "none"],
    speech: {
      ...(activeSpeechProvider ? { activeProvider: activeSpeechProvider } : {}),
      providers: listSpeechProviders(config).map((provider) => {
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({
              cfg: config,
              providerConfig: getResolvedSpeechProviderConfig(ttsConfig, provider.id, config),
              timeoutMs: ttsConfig.timeoutMs,
            }),
          ),
          modes: ["stt-tts"],
          brains: ["agent-consult"],
        };
        if (provider.models) {
          entry.models = [...provider.models];
        }
        if (provider.aliases?.length) {
          entry.aliases = [...provider.aliases];
        }
        if (provider.voices) {
          entry.voices = [...provider.voices];
        }
        return entry;
      }),
    },
    transcription: {
      ready: transcriptionSelection.ready,
      ...(activeTranscriptionProvider ? { activeProvider: activeTranscriptionProvider } : {}),
      providers: listTalkTranscriptionProviders(config, [
        transcriptionConfig.provider,
        ...Object.keys(transcriptionConfig.providers),
      ]).map((provider) => {
        const rawConfig = getVoiceProviderConfig({
          providerConfigs: transcriptionConfig.providers,
          provider,
          configuredProviderId:
            activeTranscriptionProvider &&
            normalizeOptionalLowercaseString(provider.id) ===
              normalizeOptionalLowercaseString(activeTranscriptionProvider)
              ? transcriptionConfig.provider
              : undefined,
        });
        const rawConfigWithModel =
          transcriptionConfig.model && rawConfig.model === undefined
            ? { ...rawConfig, model: transcriptionConfig.model }
            : rawConfig;
        const providerConfig =
          provider.resolveConfig?.({ cfg: config, rawConfig: rawConfigWithModel }) ??
          rawConfigWithModel;
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({ cfg: config, providerConfig }),
          ),
          modes: ["transcription"],
          transports: ["gateway-relay"],
          brains: ["none"],
        };
        if (provider.defaultModel) {
          entry.defaultModel = provider.defaultModel;
        }
        if (provider.aliases?.length) {
          entry.aliases = [...provider.aliases];
        }
        return entry;
      }),
    },
    realtime: {
      ready: realtimeSelection.ready,
      ...(activeRealtimeProvider ? { activeProvider: activeRealtimeProvider } : {}),
      providers: listRealtimeVoiceProviders(config).map((provider) => {
        const rawConfig = resolveProviderRawConfig({
          providerConfigs: realtimeConfig.providers ?? {},
          providerId: provider.id,
          configuredProviderId:
            provider.id === activeRealtimeProvider ? realtimeConfig.provider : undefined,
        });
        const rawConfigWithModel =
          realtimeConfig.model && rawConfig.model === undefined
            ? { ...rawConfig, model: realtimeConfig.model }
            : rawConfig;
        const providerConfig =
          provider.resolveConfig?.({ cfg: config, rawConfig: rawConfigWithModel }) ??
          rawConfigWithModel;
        const capabilities = provider.capabilities;
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({ cfg: config, providerConfig }),
          ),
          modes: ["realtime"],
          brains: capabilities?.supportsToolCalls === false ? ["none"] : ["agent-consult"],
          supportsBrowserSession: Boolean(
            capabilities?.supportsBrowserSession ?? provider.createBrowserSession,
          ),
        };
        if (provider.defaultModel) {
          entry.defaultModel = provider.defaultModel;
        }
        if (provider.aliases?.length) {
          entry.aliases = [...provider.aliases];
        }
        if (capabilities?.transports) {
          entry.transports = [...capabilities.transports];
        }
        if (capabilities?.inputAudioFormats) {
          entry.inputAudioFormats = capabilities.inputAudioFormats.map((format) => ({ ...format }));
        }
        if (capabilities?.outputAudioFormats) {
          entry.outputAudioFormats = capabilities.outputAudioFormats.map((format) => ({
            ...format,
          }));
        }
        if (capabilities?.supportsBargeIn !== undefined) {
          entry.supportsBargeIn = capabilities.supportsBargeIn;
        }
        if (capabilities?.supportsToolCalls !== undefined) {
          entry.supportsToolCalls = capabilities.supportsToolCalls;
        }
        if (capabilities?.supportsVideoFrames !== undefined) {
          entry.supportsVideoFrames = capabilities.supportsVideoFrames;
        }
        if (capabilities?.supportsSessionResumption !== undefined) {
          entry.supportsSessionResumption = capabilities.supportsSessionResumption;
        }
        return entry;
      }),
    },
  };
}

function isFallbackEligibleTalkReason(reason: TalkSpeakReason): boolean {
  return (
    reason === "talk_unconfigured" ||
    reason === "talk_provider_unsupported" ||
    reason === "method_unavailable"
  );
}

function talkSpeakError(reason: TalkSpeakReason, message: string) {
  const details: TalkSpeakErrorDetails = {
    reason,
    fallbackEligible: isFallbackEligibleTalkReason(reason),
  };
  return errorShape(ErrorCodes.UNAVAILABLE, message, { details });
}

function resolveTalkSpeed(params: TalkSpeakParams): number | undefined {
  if (typeof params.speed === "number") {
    return params.speed;
  }
  if (typeof params.rateWpm !== "number" || params.rateWpm <= 0) {
    return undefined;
  }
  const resolved = params.rateWpm / 175;
  if (resolved <= 0.5 || resolved >= 2) {
    return undefined;
  }
  return resolved;
}

function buildTalkSpeakOverrides(
  provider: string,
  providerConfig: TalkProviderConfig,
  config: OpenClawConfig,
  params: TalkSpeakParams,
): TtsDirectiveOverrides {
  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider?.resolveTalkOverrides) {
    return { provider };
  }
  const resolvedSpeed = resolveTalkSpeed(params);
  const resolvedVoiceId = resolveTalkVoiceId(
    providerConfig,
    normalizeOptionalString(params.voiceId),
  );
  const providerOverrides = speechProvider.resolveTalkOverrides({
    talkProviderConfig: providerConfig,
    params: {
      ...params,
      ...(resolvedVoiceId == null ? {} : { voiceId: resolvedVoiceId }),
      ...(resolvedSpeed == null ? {} : { speed: resolvedSpeed }),
    },
  });
  if (!providerOverrides || Object.keys(providerOverrides).length === 0) {
    return { provider };
  }
  return {
    provider,
    providerOverrides: {
      [provider]: providerOverrides,
    },
  };
}

async function resolveTalkResponseFromConfig(params: {
  includeSecrets: boolean;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
}): Promise<TalkConfigResponse | undefined> {
  const normalizedTalk = normalizeTalkSection(params.sourceConfig.talk);
  const configuredPayload = normalizedTalk ? buildTalkConfigResponse(normalizedTalk) : undefined;
  // Resolve provider selection from materialized config, but project provider-owned fields from
  // source config so SecretRefs stay redacted. The requested provider also avoids re-resolving them.
  const runtimeRealtime = buildTalkRealtimeConfig(params.runtimeConfig);
  const effectiveProvider = canonicalizeRealtimeVoiceProviderId(
    runtimeRealtime.provider,
    params.runtimeConfig,
  );
  const sourceRealtime = buildTalkRealtimeConfig(params.sourceConfig, effectiveProvider);
  const sourceProviders: Record<string, TalkProviderConfig> = {};
  for (const [providerId, providerConfig] of Object.entries(sourceRealtime.providers)) {
    const canonicalProviderId =
      canonicalizeRealtimeVoiceProviderId(providerId, params.runtimeConfig) ?? providerId;
    sourceProviders[canonicalProviderId] = {
      ...sourceProviders[canonicalProviderId],
      ...providerConfig,
    };
  }
  const effectiveRealtime = normalizeTalkSection({
    realtime: {
      ...(effectiveProvider ? { provider: effectiveProvider } : {}),
      ...(runtimeRealtime.model ? { model: runtimeRealtime.model } : {}),
      ...(runtimeRealtime.transport ? { transport: runtimeRealtime.transport } : {}),
      ...(Object.keys(sourceProviders).length > 0 ? { providers: sourceProviders } : {}),
    },
  })?.realtime;
  if (!configuredPayload && !effectiveRealtime) {
    return undefined;
  }
  const realtime: TalkRealtimeConfig | undefined = effectiveRealtime
    ? {
        ...configuredPayload?.realtime,
        ...effectiveRealtime,
      }
    : configuredPayload?.realtime;
  const sourcePayload: TalkConfigResponse = {
    ...configuredPayload,
    ...(realtime ? { realtime } : {}),
  };
  const payload = params.includeSecrets
    ? projectTalkSourcePayloadForSecrets(sourcePayload)
    : sourcePayload;

  const sourceResolved = resolveActiveTalkProviderConfig(normalizedTalk);
  const runtimeResolved = resolveActiveTalkProviderConfig(params.runtimeConfig.talk);
  const activeProviderId = sourceResolved?.provider ?? runtimeResolved?.provider;
  const provider = canonicalizeSpeechProviderId(activeProviderId, params.runtimeConfig);
  if (!provider) {
    return payload;
  }

  const speechProvider = getSpeechProvider(provider, params.runtimeConfig);
  const sourceBaseTts = withTalkBaseTtsSpeakerSelectionCompat(
    asOptionalRecord(params.sourceConfig.messages?.tts) ?? {},
  );
  const runtimeBaseTts = withTalkBaseTtsSpeakerSelectionCompat(
    asOptionalRecord(params.runtimeConfig.messages?.tts) ?? {},
  );
  const sourceProviderConfig = withSpeakerSelectionFallbackCompat(sourceResolved?.config);
  const runtimeProviderConfig = withSpeakerSelectionFallbackCompat(runtimeResolved?.config);
  const selectedBaseTts =
    Object.keys(runtimeBaseTts).length > 0
      ? runtimeBaseTts
      : stripUnresolvedSecretApiKeysFromBaseTtsProviders(sourceBaseTts);
  // Prefer runtime-resolved provider config and fall back to source. Provider
  // plugins (ElevenLabs/OpenAI) call strict secret helpers that throw on
  // unresolved wrappers, so only the already-authorized includeSecrets path may
  // materialize SecretRef apiKey values before provider resolution. Read-scope
  // calls keep the old strip/redact behavior.
  const providerInputConfig = await resolveTalkProviderInputConfig({
    includeSecrets: params.includeSecrets,
    config: params.runtimeConfig,
    providerConfig:
      Object.keys(runtimeProviderConfig).length > 0 ? runtimeProviderConfig : sourceProviderConfig,
    provider,
  });
  const resolvedConfig =
    speechProvider?.resolveTalkConfig?.({
      cfg: params.runtimeConfig,
      baseTtsConfig: selectedBaseTts,
      talkProviderConfig: providerInputConfig,
      timeoutMs: typeof selectedBaseTts.timeoutMs === "number" ? selectedBaseTts.timeoutMs : 30_000,
    }) ?? providerInputConfig;
  const responseConfig = projectTalkResolvedProviderConfig({
    includeSecrets: params.includeSecrets,
    sourceProviderConfig,
    resolvedConfig,
  });

  return {
    ...payload,
    provider,
    resolved: {
      provider,
      config: responseConfig,
    },
  };
}

function projectTalkResolvedProviderConfig(params: {
  includeSecrets: boolean;
  sourceProviderConfig: TalkProviderConfig;
  resolvedConfig: TalkProviderConfig;
}): TalkProviderConfig {
  if (!params.includeSecrets) {
    return params.sourceProviderConfig.apiKey === undefined
      ? params.resolvedConfig
      : { ...params.resolvedConfig, apiKey: params.sourceProviderConfig.apiKey };
  }

  // includeSecrets authorizes the active Talk provider key only. Keep resolver
  // defaults in the resolved payload, but do not turn arbitrary provider-owned
  // secret-like fields into a new native-client credential surface.
  const projected = redactConfigObject(params.resolvedConfig);
  const apiKey = normalizeOptionalString(params.resolvedConfig.apiKey);
  return apiKey === undefined ? projected : { ...projected, apiKey };
}

function projectTalkSourceProviderConfigForSecrets(config: TalkProviderConfig): TalkProviderConfig {
  const projected = redactConfigObject(config);
  if (config.apiKey === undefined || typeof config.apiKey === "string") {
    return projected;
  }
  return { ...projected, apiKey: config.apiKey };
}

function projectTalkSourceProviderMapForSecrets(
  providers: Record<string, TalkProviderConfig> | undefined,
): Record<string, TalkProviderConfig> | undefined {
  if (!providers) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(providers).map(([providerId, providerConfig]) => [
      providerId,
      projectTalkSourceProviderConfigForSecrets(providerConfig),
    ]),
  );
}

function projectTalkRealtimeForSecrets(realtime: TalkRealtimeConfig): TalkRealtimeConfig {
  const projected = redactConfigObject(realtime);
  const providers = projectTalkSourceProviderMapForSecrets(realtime.providers);
  return providers ? { ...projected, providers } : projected;
}

function projectTalkSourcePayloadForSecrets(payload: TalkConfigResponse): TalkConfigResponse {
  const projected = redactConfigObject(payload);
  const providers = projectTalkSourceProviderMapForSecrets(payload.providers);
  if (providers) {
    projected.providers = providers;
  }
  if (payload.realtime) {
    projected.realtime = projectTalkRealtimeForSecrets(payload.realtime);
  }
  return projected;
}

async function resolveTalkProviderInputConfig(params: {
  includeSecrets: boolean;
  config: OpenClawConfig;
  providerConfig: TalkProviderConfig;
  provider: string;
}): Promise<TalkProviderConfig> {
  const strippedConfig = stripUnresolvedSecretApiKey(params.providerConfig);
  if (!params.includeSecrets || params.providerConfig.apiKey === undefined) {
    return strippedConfig;
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: process.env,
    value: params.providerConfig.apiKey,
    path: `talk.providers.${params.provider}.apiKey`,
  });
  return resolved.value === undefined
    ? strippedConfig
    : { ...params.providerConfig, apiKey: resolved.value };
}

function stripUnresolvedSecretApiKey(config: TalkProviderConfig): TalkProviderConfig {
  return stripUnresolvedSecretApiKeyFromRecord(config) as TalkProviderConfig;
}

function stripUnresolvedSecretApiKeysFromBaseTtsProviders(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const providers = asOptionalRecord(base.providers);
  if (!providers) {
    return base;
  }
  let mutated = false;
  // Null-prototype map so an attacker-influenced provider id like `__proto__`,
  // `constructor`, or `prototype` cannot pollute Object.prototype via the
  // dynamic `cleaned[providerId] = ...` assignment below. Provider-id keys
  // come from operator config and may be plain JSON, so we cannot assume
  // they're already validated upstream.
  const cleaned: Record<string, unknown> = Object.create(null);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const cfg = asOptionalRecord(providerConfig);
    if (!cfg) {
      cleaned[providerId] = providerConfig;
      continue;
    }
    const next = stripUnresolvedSecretApiKeyFromRecord(cfg);
    if (next !== cfg) {
      mutated = true;
    }
    cleaned[providerId] = next;
  }
  if (!mutated) {
    return base;
  }
  return { ...base, providers: cleaned };
}

function stripUnresolvedSecretApiKeyFromRecord(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.apiKey === undefined || typeof config.apiKey === "string") {
    return config;
  }
  const { apiKey: _omit, ...rest } = config;
  return rest;
}

/** Gateway request handlers for Talk config, catalog, mode, sessions, and speech. */
export const talkHandlers: GatewayRequestHandlers = {
  ...talkSessionHandlers,
  ...talkClientHandlers,
  "talk.catalog": async ({ params, respond, context }) => {
    const catalogParams = params ?? {};
    if (!validateTalkCatalogParams(catalogParams)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.catalog params: ${formatValidationErrors(validateTalkCatalogParams.errors)}`,
        ),
      );
      return;
    }

    try {
      respond(true, buildTalkCatalog(context.getRuntimeConfig()), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.config": async ({ params, respond, client, context }) => {
    if (!validateTalkConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
        ),
      );
      return;
    }

    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    if (includeSecrets && !canReadTalkSecrets(client)) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({
          missingScope: TALK_SECRETS_SCOPE,
          requiredScopes: [READ_SCOPE, TALK_SECRETS_SCOPE],
        }),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const runtimeConfig = context.getRuntimeConfig();
    const configPayload: Record<string, unknown> = {};

    const talk = await resolveTalkResponseFromConfig({
      includeSecrets,
      sourceConfig: snapshot.config,
      runtimeConfig,
    });
    if (talk) {
      configPayload.talk = includeSecrets ? talk : redactConfigObject(talk);
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
  "talk.speak": async ({ params, respond, context }) => {
    if (!validateTalkSpeakParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.speak params: ${formatValidationErrors(validateTalkSpeakParams.errors)}`,
        ),
      );
      return;
    }

    const typedParams = params;
    const text = normalizeOptionalString(typedParams.text);
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak requires text"));
      return;
    }

    if (
      typedParams.speed == null &&
      typedParams.rateWpm != null &&
      resolveTalkSpeed(typedParams) == null
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.speak params: rateWpm must resolve to speed between 0.5 and 2.0`,
        ),
      );
      return;
    }

    try {
      const runtimeConfig = context.getRuntimeConfig();
      const setup = buildTalkTtsConfig(runtimeConfig);
      if ("error" in setup) {
        respond(false, undefined, talkSpeakError(setup.reason, setup.error));
        return;
      }

      const overrides = buildTalkSpeakOverrides(
        setup.provider,
        setup.providerConfig,
        runtimeConfig,
        typedParams,
      );
      const speechText = isCodeHeavySpeechText(text) ? CODE_HEAVY_SPOKEN_FALLBACK : text;
      const result = await synthesizeSpeech({
        text: speechText,
        cfg: setup.cfg,
        overrides,
        disableFallback: true,
      });
      if (!result.success || !result.audioBuffer) {
        respond(
          false,
          undefined,
          talkSpeakError("synthesis_failed", result.error ?? "talk synthesis failed"),
        );
        return;
      }
      if ((result.provider ?? setup.provider).trim().length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty provider"),
        );
        return;
      }
      if (result.audioBuffer.length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty audio"),
        );
        return;
      }

      respond(
        true,
        {
          audioBase64: result.audioBuffer.toString("base64"),
          provider: result.provider ?? setup.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
          mimeType: inferSpeechMimeType(result.outputFormat, result.fileExtension),
          fileExtension: result.fileExtension,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, talkSpeakError("synthesis_failed", formatForLog(err)));
    }
  },
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedTalkNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected Talk-capable nodes"),
      );
      return;
    }
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
