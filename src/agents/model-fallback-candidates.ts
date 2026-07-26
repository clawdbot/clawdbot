import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
/** Resolves ordered model and image fallback candidate chains. */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import { isPluginProvidersLoadInFlight } from "../plugins/providers.runtime.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  getPluginRegistryState,
} from "../plugins/runtime-state.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelCandidate } from "./model-fallback.types.js";
import {
  type ModelManifestNormalizationContext,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";

const MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES = 256;
const fallbackCandidateCache = new Map<string, ModelCandidate[]>();

function hasExactConfiguredProviderModel(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  const model = params.model.trim();
  if (!params.cfg || !normalizedProvider || !model) {
    return false;
  }
  for (const [providerId, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== normalizedProvider) {
      continue;
    }
    return (providerConfig.models ?? []).some((entry) => entry.id.trim() === model);
  }
  return false;
}

function hasConfiguredProvider(params: { cfg?: OpenClawConfig; provider: string }): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!params.cfg || !normalizedProvider) {
    return false;
  }
  return Object.keys(params.cfg.models?.providers ?? {}).some(
    (providerId) => normalizeProviderId(providerId) === normalizedProvider,
  );
}

function allowPluginModelNormalizationForRef(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  if (
    params.cfg &&
    !normalizePluginsConfig(params.cfg.plugins).enabled &&
    hasConfiguredProvider(params)
  ) {
    return false;
  }
  return !hasExactConfiguredProviderModel(params);
}

function createModelCandidateCollector(): {
  candidates: ModelCandidate[];
  addExplicitCandidate: (candidate: ModelCandidate) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  return {
    candidates,
    addExplicitCandidate: addCandidate,
  };
}

export function resolveImageFallbackCandidates(
  params: {
    cfg: OpenClawConfig | undefined;
    defaultProvider: string;
    modelOverride?: string;
  } & ModelManifestNormalizationContext,
): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addExplicitCandidate } = createModelCandidateCollector();

  const addRaw = (raw: string) => {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      return;
    }
    addExplicitCandidate(resolved.ref);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride);
  } else {
    const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
    if (primary?.trim()) {
      addRaw(primary);
    }
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);
  for (const raw of imageFallbacks) {
    // Explicitly configured image fallbacks should remain reachable even when a
    // model allowlist is present.
    addRaw(raw);
  }
  return candidates;
}

export function resolveImageFallbackDefaultProvider(cfg: OpenClawConfig | undefined): string {
  const configuredPrimary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.imageModel);
  if (configuredPrimary?.trim()) {
    const aliasIndex = buildModelAliasIndex({
      cfg: cfg ?? {},
      defaultProvider: DEFAULT_PROVIDER,
    });
    const resolved = resolveModelRefFromString({
      cfg,
      raw: configuredPrimary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (resolved?.ref.provider) {
      return resolved.ref.provider;
    }
  }
  return DEFAULT_PROVIDER;
}

export function resolveModelCandidateChain(
  params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
    fallbacksOverride?: string[];
  } & ModelManifestNormalizationContext,
): ModelCandidate[] {
  const cacheKey = resolveFallbackCandidateCacheKey(params);
  if (cacheKey) {
    const cached = fallbackCandidateCache.get(cacheKey);
    if (cached) {
      return cached.map(cloneModelCandidate);
    }
  }
  const candidates = resolveFallbackCandidatesUncached(params);
  if (cacheKey) {
    fallbackCandidateCache.set(cacheKey, candidates.map(cloneModelCandidate));
    while (fallbackCandidateCache.size > MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES) {
      const oldest = fallbackCandidateCache.keys().next();
      if (oldest.done) {
        break;
      }
      fallbackCandidateCache.delete(oldest.value);
    }
  }
  return candidates;
}

function cloneModelCandidate(candidate: ModelCandidate): ModelCandidate {
  return { provider: candidate.provider, model: candidate.model };
}

function resolveFallbackCandidateCacheKey(
  params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    fallbacksOverride?: string[];
  } & ModelManifestNormalizationContext,
): string | null {
  if (params.manifestPlugins) {
    return null;
  }
  const workspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  const env = process.env;
  const pluginMetadata = getCurrentPluginMetadataSnapshot({
    env,
    workspaceDir,
    allowWorkspaceScopedSnapshot: true,
  });
  const providerLoadMetadata = getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    env,
    workspaceDir,
    allowWorkspaceScopedSnapshot: true,
  });
  if (
    isPluginProvidersLoadInFlight({
      config: params.cfg,
      workspaceDir,
      env,
      ...(providerLoadMetadata ? { pluginMetadataSnapshot: providerLoadMetadata } : {}),
      activate: false,
      bundledProviderVitestCompat: true,
    })
  ) {
    return null;
  }
  const registryState = getPluginRegistryState();
  return JSON.stringify({
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
    agentsDefaultsModel: params.cfg?.agents?.defaults?.model,
    agentsDefaultsModels: params.cfg?.agents?.defaults?.models,
    modelProviders: resolveFallbackCandidateModelProviderCacheParts(params.cfg),
    pluginControlPlane: resolvePluginControlPlaneFingerprint({
      config: params.cfg,
      env,
      workspaceDir,
    }),
    pluginMetadataFingerprint: pluginMetadata?.configFingerprint ?? null,
    pluginRegistryKey: registryState?.key ?? null,
    pluginRegistryVersion: registryState?.activeVersion ?? null,
    pluginWorkspaceDir: workspaceDir ?? null,
  });
}

function resolveFallbackCandidateModelProviderCacheParts(cfg: OpenClawConfig | undefined): unknown {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  return Object.entries(providers).map(([providerId, providerConfig]) => ({
    providerId,
    api: typeof providerConfig?.api === "string" ? providerConfig.api : undefined,
    models: Array.isArray(providerConfig?.models)
      ? providerConfig.models
          .map((entry) => (typeof entry?.id === "string" ? entry.id : undefined))
          .filter((id): id is string => id !== undefined)
      : [],
  }));
}

function resolveFallbackCandidatesUncached(
  params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    fallbacksOverride?: string[];
  } & ModelManifestNormalizationContext,
): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = normalizeOptionalString(params.provider) || defaultProvider;
  const modelRaw = normalizeOptionalString(params.model) || defaultModel;
  const normalizeCandidateRef = (provider: string, model: string) =>
    normalizeModelRef(provider, model, {
      allowPluginNormalization: allowPluginModelNormalizationForRef({
        cfg: params.cfg,
        provider,
        model,
      }),
      manifestPlugins: params.manifestPlugins,
    });
  const allowPluginModelAliases = params.cfg
    ? normalizePluginsConfig(params.cfg.plugins).enabled
    : true;
  const normalizedPrimary = normalizeCandidateRef(providerRaw, modelRaw);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
    allowPluginNormalization: allowPluginModelAliases,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addExplicitCandidate } = createModelCandidateCollector();
  const resolvedModelAlias = resolveModelRefFromString({
    cfg: params.cfg,
    raw: modelRaw,
    defaultProvider: providerRaw,
    aliasIndex,
    allowPluginNormalization: allowPluginModelNormalizationForRef({
      cfg: params.cfg,
      provider: providerRaw,
      model: modelRaw,
    }),
    manifestPlugins: params.manifestPlugins,
  });
  const resolvedProviderModelAlias = resolveModelRefFromString({
    cfg: params.cfg,
    raw: `${providerRaw}/${modelRaw}`,
    defaultProvider,
    aliasIndex,
    allowPluginNormalization: allowPluginModelNormalizationForRef({
      cfg: params.cfg,
      provider: providerRaw,
      model: modelRaw,
    }),
    manifestPlugins: params.manifestPlugins,
  });
  const resolvedBareModelAlias =
    resolvedModelAlias?.alias &&
    (resolvedModelAlias.ref.provider === normalizedPrimary.provider ||
      normalizedPrimary.provider === defaultProvider)
      ? resolvedModelAlias.ref
      : null;
  const resolvedPrimary =
    (resolvedProviderModelAlias?.alias ? resolvedProviderModelAlias.ref : null) ??
    resolvedBareModelAlias ??
    normalizedPrimary;
  const effectivePrimary = normalizeCandidateRef(resolvedPrimary.provider, resolvedPrimary.model);
  addExplicitCandidate(effectivePrimary);

  const modelFallbacks =
    params.fallbacksOverride !== undefined
      ? params.fallbacksOverride
      : resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider,
      aliasIndex,
      allowPluginNormalization: allowPluginModelAliases,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      continue;
    }
    // Fallbacks are explicit user intent; do not silently filter them by the
    // model allowlist.
    addExplicitCandidate(normalizeCandidateRef(resolved.ref.provider, resolved.ref.model));
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addExplicitCandidate(normalizeCandidateRef(primary.provider, primary.model));
  }
  return candidates;
}
