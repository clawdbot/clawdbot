import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelCatalogMergeKey,
  planManifestModelCatalogSuppressions,
  type ManifestModelCatalogSuppressionEntry,
} from "../model-catalog/index.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

type ManifestSuppressionCache = Map<string, readonly ManifestModelCatalogSuppressionEntry[]>;

let cacheWithoutConfig = new WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>();
let cacheByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>
>();

function resolveSuppressionCache(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ManifestSuppressionCache {
  if (!params.config) {
    let cache = cacheWithoutConfig.get(params.env);
    if (!cache) {
      cache = new Map();
      cacheWithoutConfig.set(params.env, cache);
    }
    return cache;
  }
  let envCaches = cacheByConfig.get(params.config);
  if (!envCaches) {
    envCaches = new WeakMap();
    cacheByConfig.set(params.config, envCaches);
  }
  let cache = envCaches.get(params.env);
  if (!cache) {
    cache = new Map();
    envCaches.set(params.env, cache);
  }
  return cache;
}

function cacheKey(params: { workspaceDir?: string }): string {
  return params.workspaceDir ?? "";
}

function listManifestModelCatalogSuppressions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): readonly ManifestModelCatalogSuppressionEntry[] {
  const cache = resolveSuppressionCache({
    config: params.config,
    env: params.env,
  });
  const key = cacheKey(params);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const planned = planManifestModelCatalogSuppressions({ registry });
  cache.set(key, planned.suppressions);
  return planned.suppressions;
}

function buildManifestSuppressionError(params: {
  provider: string;
  modelId: string;
  reason?: string;
}): string {
  const ref = `${params.provider}/${params.modelId}`;
  return params.reason ? `Unknown model: ${ref}. ${params.reason}` : `Unknown model: ${ref}.`;
}

function normalizeBaseUrlHost(baseUrl: string | null | undefined): string {
  if (!baseUrl?.trim()) {
    return "";
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function resolveConfiguredProviderValue(params: {
  provider: string;
  config?: OpenClawConfig;
}): { api?: string; baseUrl?: string } | undefined {
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (normalizeLowercaseStringOrEmpty(providerId) !== params.provider) {
      continue;
    }
    return {
      api: normalizeLowercaseStringOrEmpty(entry?.api),
      baseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined,
    };
  }
  return undefined;
}

function manifestSuppressionMatchesConditions(params: {
  suppression: ManifestModelCatalogSuppressionEntry;
  provider: string;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}): boolean {
  const when = params.suppression.when;
  if (!when) {
    return true;
  }
  const configuredProvider = resolveConfiguredProviderValue({
    provider: params.provider,
    config: params.config,
  });
  if (when.providerConfigApiIn?.length && configuredProvider?.api) {
    const allowedApis = new Set(when.providerConfigApiIn.map(normalizeLowercaseStringOrEmpty));
    if (!allowedApis.has(configuredProvider.api)) {
      return false;
    }
  }
  if (when.baseUrlHosts?.length) {
    const baseUrlHost = normalizeBaseUrlHost(params.baseUrl ?? configuredProvider?.baseUrl);
    if (!baseUrlHost) {
      return false;
    }
    const allowedHosts = new Set(when.baseUrlHosts.map(normalizeLowercaseStringOrEmpty));
    if (!allowedHosts.has(baseUrlHost)) {
      return false;
    }
  }
  return true;
}

export function clearManifestModelSuppressionCacheForTest(): void {
  cacheWithoutConfig = new WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>();
  cacheByConfig = new WeakMap<
    OpenClawConfig,
    WeakMap<NodeJS.ProcessEnv, ManifestSuppressionCache>
  >();
}

export function resolveManifestBuiltInModelSuppression(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string | null;
}) {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const modelId = normalizeLowercaseStringOrEmpty(params.id);
  if (!provider || !modelId) {
    return undefined;
  }
  const mergeKey = buildModelCatalogMergeKey(provider, modelId);
  const suppression = listManifestModelCatalogSuppressions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
  }).find(
    (entry) =>
      entry.mergeKey === mergeKey &&
      manifestSuppressionMatchesConditions({
        suppression: entry,
        provider,
        baseUrl: params.baseUrl,
        config: params.config,
      }),
  );
  if (!suppression) {
    return undefined;
  }
  return {
    suppress: true,
    errorMessage: buildManifestSuppressionError({
      provider,
      modelId,
      reason: suppression.reason,
    }),
  };
}
