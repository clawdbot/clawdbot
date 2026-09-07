import { clampTimerTimeoutMs } from "../../packages/normalization-core/src/number-coercion.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type {
  OpenClawConfig,
  ResolvedTtsPersona,
  TtsConfig,
  TtsProvider,
} from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { compareSpeechProviderOrder } from "./provider-registry-core.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
} from "./provider-registry.js";
import type { SpeechProviderConfig } from "./provider-types.js";
import { withSpeakerSelectionCompat } from "./speaker.js";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  asProviderConfig,
  asProviderConfigMap,
  normalizeConfiguredSpeechProviderId,
  readTtsPrefs as readPrefs,
  resolveTtsPersonaFromPrefs,
  resolveTtsRuntimeConfig,
  type ResolvedTtsConfig,
  type TtsProviderPreference,
} from "./tts-settings.js";
import {
  resolvePrimaryVoiceProviderCandidate,
  resolveSupportedVoiceModelRefs,
  resolveVoiceModelRefs,
  resolveVoiceProviderCandidates,
  voiceProviderSupportsModel,
  type VoiceModelProvider,
  type VoiceModelRef,
  type VoiceProviderCandidate,
} from "./voice-models.js";

function resolvePositiveTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? clampTimerTimeoutMs(timeoutMs)
    : undefined;
}

export function resolveSpeechProviderTimeoutMs(params: {
  timeoutMs?: number;
  config: ResolvedTtsConfig;
  provider: Pick<SpeechProviderPlugin, "defaultTimeoutMs">;
}): number {
  if (params.timeoutMs !== undefined) {
    return resolvePositiveTimeoutMs(params.timeoutMs) ?? params.config.timeoutMs;
  }
  if (params.config.timeoutMsSource !== "default") {
    return resolvePositiveTimeoutMs(params.config.timeoutMs) ?? DEFAULT_TTS_TIMEOUT_MS;
  }
  return resolvePositiveTimeoutMs(params.provider.defaultTimeoutMs) ?? params.config.timeoutMs;
}

function sortSpeechProvidersForAutoSelection(
  cfg?: OpenClawConfig,
  providers?: readonly SpeechProviderPlugin[],
) {
  return [...(providers ?? listSpeechProviders(cfg))].toSorted(compareSpeechProviderOrder);
}

function canonicalizeSpeechProviderIdFromInventory(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
  providers?: readonly SpeechProviderPlugin[],
): string | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  if (!providers) {
    return canonicalizeSpeechProviderId(providerId, cfg);
  }
  const inventoryProvider = providers.find(
    (provider) =>
      normalizeSpeechProviderId(provider.id) === normalized ||
      provider.aliases?.some((alias) => normalizeSpeechProviderId(alias) === normalized),
  );
  // A prepared inventory can omit voice-model-only providers. Preserve the
  // registry's public alias contract on misses instead of exposing an alias.
  return inventoryProvider?.id ?? canonicalizeSpeechProviderId(providerId, cfg) ?? normalized;
}

function resolveConfiguredSpeechVoiceModelRefs(
  cfg: OpenClawConfig | undefined,
  providers?: readonly SpeechProviderPlugin[],
): VoiceModelRef[] {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : undefined;
  return resolveSupportedVoiceModelRefs({
    config: effectiveCfg?.agents?.defaults?.voiceModel,
    providers: sortSpeechProvidersForAutoSelection(effectiveCfg, providers),
  });
}

function resolveConfiguredSpeechVoiceModelForProvider(params: {
  cfg: OpenClawConfig | undefined;
  providerId: string;
  provider?: VoiceModelProvider;
  voiceModel?: VoiceModelRef;
}): VoiceModelRef | undefined {
  const provider = params.provider ?? getSpeechProvider(params.providerId, params.cfg);
  if (params.voiceModel) {
    return voiceProviderSupportsModel(provider, params.voiceModel.model)
      ? params.voiceModel
      : undefined;
  }
  return resolveSupportedVoiceModelRefs({
    config: params.cfg?.agents?.defaults?.voiceModel,
    providers: provider ? [provider] : [],
    providerId: params.providerId,
  })[0];
}

function applyVoiceModelToSpeechProviderConfig(params: {
  cfg: OpenClawConfig | undefined;
  providerId: string;
  providerConfig: SpeechProviderConfig;
  provider?: VoiceModelProvider;
  voiceModel?: VoiceModelRef;
}): SpeechProviderConfig {
  const voiceModel = resolveConfiguredSpeechVoiceModelForProvider({
    cfg: params.cfg,
    providerId: params.providerId,
    provider: params.provider,
    voiceModel: params.voiceModel,
  });
  if (!voiceModel) {
    return params.providerConfig;
  }
  const hasExplicitModel =
    normalizeOptionalString(params.providerConfig.model) ||
    normalizeOptionalString(params.providerConfig.modelId);
  if (hasExplicitModel) {
    return params.providerConfig;
  }
  return {
    ...params.providerConfig,
    model: voiceModel.model,
    modelId: voiceModel.model,
  };
}

export function resolvePersonaProviderConfig(
  persona: ResolvedTtsPersona | undefined,
  providerId: string,
): SpeechProviderConfig | undefined {
  if (!persona?.providers) {
    return undefined;
  }
  const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
  if (Object.hasOwn(persona.providers, normalized)) {
    return persona.providers[normalized];
  }
  if (Object.hasOwn(persona.providers, providerId)) {
    return persona.providers[providerId];
  }
  return undefined;
}

export function mergeProviderConfigWithPersona(params: {
  providerConfig: SpeechProviderConfig;
  persona?: ResolvedTtsPersona;
  providerId: string;
}): {
  providerConfig: SpeechProviderConfig;
  personaProviderConfig?: SpeechProviderConfig;
  personaBinding: "applied" | "missing" | "none";
} {
  if (!params.persona) {
    return { providerConfig: params.providerConfig, personaBinding: "none" };
  }
  const personaProviderConfig = resolvePersonaProviderConfig(params.persona, params.providerId);
  if (!personaProviderConfig) {
    return { providerConfig: params.providerConfig, personaBinding: "missing" };
  }
  return {
    providerConfig: {
      ...params.providerConfig,
      ...personaProviderConfig,
    },
    personaProviderConfig,
    personaBinding: "applied",
  };
}

function resolveRawProviderConfig(
  raw: TtsConfig | undefined,
  providerId: string,
): SpeechProviderConfig {
  if (!raw) {
    return {};
  }
  const rawProviders = asProviderConfigMap(raw.providers);
  const direct = rawProviders[providerId] ?? (raw as Record<string, unknown>)[providerId];
  return withSpeakerSelectionCompat(asProviderConfig(direct));
}

function resolveLazyProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
  voiceModel?: VoiceModelRef,
  provider?: SpeechProviderPlugin,
): SpeechProviderConfig {
  const canonical =
    normalizeConfiguredSpeechProviderId(providerId) ?? normalizeLowercaseStringOrEmpty(providerId);
  const existing = voiceModel ? undefined : config.providerConfigs[canonical];
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : config.sourceConfig;
  if (existing && !effectiveCfg) {
    return existing;
  }
  const rawConfig = resolveRawProviderConfig(config.rawConfig, canonical);
  const rawBaseConfig = config.rawConfig as Record<string, unknown> | undefined;
  const rawProviders = asProviderConfigMap(config.rawConfig?.providers);
  const resolvedProvider = provider ?? getSpeechProvider(canonical, effectiveCfg);
  let hasRawProviderConfig =
    Object.hasOwn(rawProviders, canonical) ||
    (rawBaseConfig ? Object.hasOwn(rawBaseConfig, canonical) : false);
  let rawProviderConfig = rawProviders[canonical] ?? rawBaseConfig?.[canonical];
  if (!hasRawProviderConfig) {
    for (const alias of resolvedProvider?.aliases ?? []) {
      const normalizedAlias = normalizeSpeechProviderId(alias);
      if (!normalizedAlias) {
        continue;
      }
      if (Object.hasOwn(rawProviders, normalizedAlias)) {
        hasRawProviderConfig = true;
        rawProviderConfig = rawProviders[normalizedAlias];
        break;
      }
      if (rawBaseConfig && Object.hasOwn(rawBaseConfig, normalizedAlias)) {
        hasRawProviderConfig = true;
        rawProviderConfig = rawBaseConfig[normalizedAlias];
        break;
      }
    }
  }
  const compatRawProviderConfig = applyVoiceModelToSpeechProviderConfig({
    cfg: effectiveCfg,
    providerId: canonical,
    providerConfig: withSpeakerSelectionCompat(asProviderConfig(rawProviderConfig)),
    provider: resolvedProvider,
    voiceModel,
  });
  const shouldInjectCanonicalProviderConfig =
    hasRawProviderConfig || Boolean(voiceModel) || Object.keys(rawProviders).length === 0;
  const rawConfigForProvider = {
    ...rawBaseConfig,
    providers: shouldInjectCanonicalProviderConfig
      ? {
          ...rawProviders,
          [canonical]: compatRawProviderConfig,
        }
      : rawProviders,
    ...(shouldInjectCanonicalProviderConfig ? { [canonical]: compatRawProviderConfig } : {}),
  };
  const next = withSpeakerSelectionCompat(
    effectiveCfg && resolvedProvider?.resolveConfig
      ? resolvedProvider.resolveConfig({
          cfg: effectiveCfg,
          rawConfig: rawConfigForProvider,
          timeoutMs: resolveSpeechProviderTimeoutMs({ config, provider: resolvedProvider }),
        })
      : applyVoiceModelToSpeechProviderConfig({
          cfg: effectiveCfg,
          providerId: canonical,
          providerConfig: rawConfig,
          provider: resolvedProvider,
          voiceModel,
        }),
  );
  if (!voiceModel) {
    config.providerConfigs[canonical] = next;
  }
  return next;
}

export function getResolvedSpeechProviderConfig(
  config: ResolvedTtsConfig,
  providerId: string,
  cfg?: OpenClawConfig,
): SpeechProviderConfig {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : config.sourceConfig;
  const canonical =
    canonicalizeSpeechProviderId(providerId, effectiveCfg) ??
    normalizeConfiguredSpeechProviderId(providerId) ??
    normalizeLowercaseStringOrEmpty(providerId);
  return resolveLazyProviderConfig(config, canonical, effectiveCfg);
}

function getResolvedSpeechProviderConfigFromInventory(params: {
  config: ResolvedTtsConfig;
  provider: SpeechProviderPlugin;
  cfg?: OpenClawConfig;
}): SpeechProviderConfig {
  const effectiveCfg = params.cfg
    ? resolveTtsRuntimeConfig(params.cfg)
    : params.config.sourceConfig;
  return resolveLazyProviderConfig(
    params.config,
    params.provider.id,
    effectiveCfg,
    undefined,
    params.provider,
  );
}

export function getResolvedSpeechProviderConfigForVoiceModel(params: {
  config: ResolvedTtsConfig;
  providerId: string;
  cfg: OpenClawConfig;
  voiceModel?: VoiceModelRef;
}): SpeechProviderConfig {
  if (!params.voiceModel) {
    return getResolvedSpeechProviderConfig(params.config, params.providerId, params.cfg);
  }
  const effectiveCfg = resolveTtsRuntimeConfig(params.cfg);
  const canonical =
    canonicalizeSpeechProviderId(params.providerId, effectiveCfg) ??
    normalizeConfiguredSpeechProviderId(params.providerId) ??
    normalizeLowercaseStringOrEmpty(params.providerId);
  return resolveLazyProviderConfig(params.config, canonical, effectiveCfg, params.voiceModel);
}

export function resolveTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  const prefs = readPrefs(prefsPath);
  const prefsProvider =
    canonicalizeSpeechProviderId(prefs.tts?.provider) ??
    normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
  if (prefsProvider) {
    return prefsProvider;
  }
  const activePersona = resolveTtsPersonaFromPrefs(config, prefs);
  const personaProvider =
    canonicalizeSpeechProviderId(activePersona?.provider, config.sourceConfig) ??
    normalizeConfiguredSpeechProviderId(activePersona?.provider);
  if (personaProvider && getSpeechProvider(personaProvider, config.sourceConfig)) {
    return personaProvider;
  }
  if (config.providerSource === "config") {
    return normalizeConfiguredSpeechProviderId(config.provider) ?? config.provider;
  }
  const configuredVoiceProvider = resolveConfiguredSpeechVoiceModelRefs(config.sourceConfig)[0]
    ?.provider;
  if (configuredVoiceProvider && getSpeechProvider(configuredVoiceProvider, config.sourceConfig)) {
    return configuredVoiceProvider;
  }

  const effectiveCfg = config.sourceConfig;
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg)) {
    if (isTtsProviderConfigured(config, provider.id, effectiveCfg)) {
      return provider.id;
    }
  }
  return config.provider;
}

export function resolvePreparedTtsProvider(params: {
  config: ResolvedTtsConfig;
  preference?: TtsProviderPreference;
  providers: readonly SpeechProviderPlugin[];
  configuredByProvider: ReadonlyMap<string, boolean>;
}): TtsProvider {
  const effectiveCfg = params.config.sourceConfig;
  if (params.preference?.source === "prefs") {
    return (
      canonicalizeSpeechProviderIdFromInventory(
        params.preference.provider,
        effectiveCfg,
        params.providers,
      ) ?? params.preference.provider
    );
  }
  if (params.preference?.source === "persona") {
    const preferredProvider = params.preference.provider;
    const inventoryProvider = params.providers.find(
      (provider) =>
        normalizeSpeechProviderId(provider.id) === normalizeSpeechProviderId(preferredProvider) ||
        provider.aliases?.some(
          (alias) =>
            normalizeSpeechProviderId(alias) === normalizeSpeechProviderId(preferredProvider),
        ),
    );
    const personaProvider = inventoryProvider ?? getSpeechProvider(preferredProvider, effectiveCfg);
    if (personaProvider) {
      return personaProvider.id;
    }
  }
  if (params.preference?.source === "config") {
    return (
      normalizeConfiguredSpeechProviderId(params.preference.provider) ?? params.preference.provider
    );
  }
  const configuredVoiceProvider = resolveConfiguredSpeechVoiceModelRefs(
    effectiveCfg,
    params.providers,
  )[0]?.provider;
  if (configuredVoiceProvider) {
    return configuredVoiceProvider;
  }
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg, params.providers)) {
    if (params.configuredByProvider.get(provider.id) === true) {
      return provider.id;
    }
  }
  return params.config.provider;
}

export function resolveTtsProviderOrder(
  primary: TtsProvider,
  cfg?: OpenClawConfig,
  providers?: readonly SpeechProviderPlugin[],
): TtsProvider[] {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : undefined;
  const normalizedPrimary =
    canonicalizeSpeechProviderIdFromInventory(primary, effectiveCfg, providers) ?? primary;
  const ordered = new Set<TtsProvider>([normalizedPrimary]);
  for (const ref of resolveVoiceModelRefs(effectiveCfg?.agents?.defaults?.voiceModel)) {
    const provider =
      canonicalizeSpeechProviderIdFromInventory(ref.provider, effectiveCfg, providers) ??
      ref.provider;
    if (provider !== normalizedPrimary) {
      ordered.add(provider);
    }
  }
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg, providers)) {
    const normalized = provider.id;
    if (normalized !== normalizedPrimary) {
      ordered.add(normalized);
    }
  }
  return [...ordered];
}

export function resolveTtsProviderCandidates(
  primary: TtsProvider,
  cfg?: OpenClawConfig,
): VoiceProviderCandidate[] {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : undefined;
  const normalizedPrimary = canonicalizeSpeechProviderId(primary, effectiveCfg) ?? primary;
  return resolveVoiceProviderCandidates({
    primaryProvider: normalizedPrimary,
    providers: sortSpeechProvidersForAutoSelection(effectiveCfg),
    voiceModelConfig: effectiveCfg?.agents?.defaults?.voiceModel,
  });
}

export function resolvePrimaryTtsProviderCandidate(
  primary: TtsProvider,
  cfg?: OpenClawConfig,
): VoiceProviderCandidate {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : undefined;
  return resolvePrimaryVoiceProviderCandidate({
    primaryProvider: canonicalizeSpeechProviderId(primary, effectiveCfg) ?? primary,
    providers: sortSpeechProvidersForAutoSelection(effectiveCfg),
    voiceModelConfig: effectiveCfg?.agents?.defaults?.voiceModel,
  });
}

export function isTtsProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider | SpeechProviderPlugin,
  cfg?: OpenClawConfig,
): boolean {
  try {
    const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : config.sourceConfig;
    const resolvedProvider =
      typeof provider === "string" ? getSpeechProvider(provider, effectiveCfg) : provider;
    if (!resolvedProvider) {
      return false;
    }
    return (
      resolvedProvider.isConfigured({
        cfg: effectiveCfg,
        providerConfig:
          typeof provider === "string"
            ? getResolvedSpeechProviderConfig(config, resolvedProvider.id, effectiveCfg)
            : getResolvedSpeechProviderConfigFromInventory({
                config,
                provider: resolvedProvider,
                cfg: effectiveCfg,
              }),
        timeoutMs: resolveSpeechProviderTimeoutMs({ config, provider: resolvedProvider }),
      }) ?? false
    );
  } catch {
    // Configuration probes drive provider selection and status catalogs. A
    // malformed provider config must not hide other usable providers.
    return false;
  }
}
