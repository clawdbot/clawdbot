// Resolves model suppression metadata declared by plugin manifests.
import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  planManifestModelCatalogSuppressions,
  type ManifestModelCatalogSuppressionEntry,
} from "../model-catalog/index.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";
import type { ManifestModelSuppressionResolver } from "./manifest-model-suppression.types.js";
import { getPluginMetadataSnapshotCache } from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

function listManifestModelCatalogSuppressions(params: {
  config?: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
}): readonly ManifestModelCatalogSuppressionEntry[] {
  const snapshot = params.snapshot;
  const registry = {
    diagnostics: snapshot.diagnostics,
    plugins: snapshot.plugins.filter((plugin) =>
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
      }),
    ),
  };
  const planned = planManifestModelCatalogSuppressions({ registry });
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
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return normalizeSuppressionHost(new URL(trimmed).hostname);
  } catch {
    return "";
  }
}

function normalizeSuppressionHost(host: string): string {
  return normalizeLowercaseStringOrEmpty(host).replace(/\.+$/, "");
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
  if (when.providerConfigApiIn?.length) {
    const allowedApis = new Set(when.providerConfigApiIn.map(normalizeLowercaseStringOrEmpty));
    const effectiveApi = configuredProvider
      ? normalizeLowercaseStringOrEmpty(configuredProvider.api)
      : params.provider;
    if (!effectiveApi || !allowedApis.has(effectiveApi)) {
      return false;
    }
  }
  if (when.baseUrlHosts?.length) {
    const baseUrlHost = normalizeBaseUrlHost(params.baseUrl ?? configuredProvider?.baseUrl);
    if (!baseUrlHost && !params.baseUrl && !configuredProvider?.baseUrl) {
      return true;
    }
    if (!baseUrlHost) {
      return false;
    }
    const allowedHosts = new Set(when.baseUrlHosts.map(normalizeSuppressionHost));
    if (!allowedHosts.has(baseUrlHost)) {
      return false;
    }
  }
  return true;
}

export function buildManifestBuiltInModelSuppressionResolver(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ManifestModelSuppressionResolver {
  const snapshot = loadManifestMetadataSnapshot(params);
  const cache = getPluginMetadataSnapshotCache(snapshot).metadata.modelSuppressionResolvers;
  let compiled = cache.get(snapshot);
  if (!compiled) {
    compiled = { byConfig: new WeakMap() };
    cache.set(snapshot, compiled);
  }
  const cached = params.config ? compiled.byConfig.get(params.config) : compiled.unconfigured;
  if (cached) {
    return cached;
  }
  const suppressions = listManifestModelCatalogSuppressions({
    snapshot,
    config: params.config,
  });

  const resolver: ManifestModelSuppressionResolver = (input) => {
    const provider = normalizeLowercaseStringOrEmpty(input.provider);
    const modelId = normalizeLowercaseStringOrEmpty(input.id);
    if (!provider || !modelId) {
      return undefined;
    }
    const mergeKey = buildModelCatalogMergeKey(provider, modelId);
    const suppression = suppressions.find(
      (entry) =>
        entry.mergeKey === mergeKey &&
        (!input.unconditionalOnly || !entry.when) &&
        manifestSuppressionMatchesConditions({
          suppression: entry,
          provider,
          baseUrl: input.baseUrl,
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
  };
  if (params.config) {
    compiled.byConfig.set(params.config, resolver);
  } else {
    compiled.unconfigured = resolver;
  }
  return resolver;
}
