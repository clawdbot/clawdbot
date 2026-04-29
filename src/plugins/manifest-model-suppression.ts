import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelCatalogMergeKey,
  planManifestModelCatalogSuppressions,
  type ManifestModelCatalogSuppressionEntry,
} from "../model-catalog/index.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

function listManifestModelCatalogSuppressions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): readonly ManifestModelCatalogSuppressionEntry[] {
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
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
    const allowedHosts = new Set(when.baseUrlHosts.map(normalizeSuppressionHost));
    if (!allowedHosts.has(baseUrlHost)) {
      return false;
    }
  }
  return true;
}

export function clearManifestModelSuppressionCacheForTest(): void {
  // Manifest suppressions are read fresh. Keep the test hook as a no-op.
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
