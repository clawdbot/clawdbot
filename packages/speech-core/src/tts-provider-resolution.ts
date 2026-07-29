import type {
  OpenClawConfig,
  ResolvedTtsPersona,
  TtsConfig,
  TtsProvider,
} from "openclaw/plugin-sdk/config-contracts";
import { clampTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
  type SpeechProviderConfig,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { withSpeakerSelectionCompat } from "../speaker.js";
import {
  resolvePrimaryVoiceProviderCandidate,
  resolveSupportedVoiceModelRefs,
  resolveVoiceModelRefs,
  resolveVoiceProviderCandidates,
  voiceProviderSupportsModel,
  type VoiceModelProvider,
  type VoiceModelRef,
  type VoiceProviderCandidate,
} from "../voice-models.js";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  asProviderConfig,
  asProviderConfigMap,
  hasOwnProperty,
  normalizeConfiguredSpeechProviderId,
  readTtsPrefs as readPrefs,
  resolveTtsPersonaFromPrefs,
  resolveTtsRuntimeConfig,
  type ResolvedTtsConfig,
} from "./tts-settings.js";

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

function sortSpeechProvidersForAutoSelection(cfg?: OpenClawConfig) {
  return listSpeechProviders(cfg).toSorted((left, right) => {
    const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function resolveConfiguredSpeechVoiceModelRefs(cfg: OpenClawConfig | undefined): VoiceModelRef[] {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : undefined;
  return resolveSupportedVoiceModelRefs({
    config: effectiveCfg?.agents?.defaults?.voiceModel,
    providers: sortSpeechProvidersForAutoSelection(effectiveCfg),
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
  if (hasOwnProperty(persona.providers, normalized)) {
    return persona.providers[normalized];
  }
  if (hasOwnProperty(persona.providers, providerId)) {
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
  const resolvedProvider = getSpeechProvider(canonical, effectiveCfg);
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

export function resolveTtsProviderOrder(primary: TtsProvider, cfg?: OpenClawConfig): TtsProvider[] {
  const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : undefined;
  const normalizedPrimary = canonicalizeSpeechProviderId(primary, effectiveCfg) ?? primary;
  const ordered = new Set<TtsProvider>([normalizedPrimary]);
  for (const ref of resolveVoiceModelRefs(effectiveCfg?.agents?.defaults?.voiceModel)) {
    const provider = canonicalizeSpeechProviderId(ref.provider, effectiveCfg) ?? ref.provider;
    if (provider !== normalizedPrimary) {
      ordered.add(provider);
    }
  }
  for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg)) {
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
  provider: TtsProvider,
  cfg?: OpenClawConfig,
): boolean {
  try {
    const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : config.sourceConfig;
    const resolvedProvider = getSpeechProvider(provider, effectiveCfg);
    if (!resolvedProvider) {
      return false;
    }
    return (
      resolvedProvider.isConfigured({
        cfg: effectiveCfg,
        providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, effectiveCfg),
        timeoutMs: resolveSpeechProviderTimeoutMs({ config, provider: resolvedProvider }),
      }) ?? false
    );
  } catch {
    // Configuration probes drive provider selection and status catalogs. A
    // malformed provider config must not hide other usable providers.
    return false;
  }
}
