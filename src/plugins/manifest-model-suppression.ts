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

type PreparedManifestSuppression = {
  entry: ManifestModelCatalogSuppressionEntry;
  allowedApis: ReadonlySet<string> | undefined;
  allowedHosts: ReadonlySet<string> | undefined;
};

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
  suppression: PreparedManifestSuppression;
  provider: string;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}): boolean {
  const { entry, allowedApis, allowedHosts } = params.suppression;
  const when = entry.when;
  if (!when) {
    return true;
  }
  // Retirement repairs durable model choices. A missing route is unknown, even
  // when the provider's default endpoint is known; never retire a sibling auth route.
  if (entry.retirement && allowedHosts && !params.baseUrl) {
    return false;
  }
  const configuredProvider = resolveConfiguredProviderValue({
    provider: params.provider,
    config: params.config,
  });
  if (allowedApis) {
    const effectiveApi = configuredProvider
      ? normalizeLowercaseStringOrEmpty(configuredProvider.api)
      : params.provider;
    if (!effectiveApi || !allowedApis.has(effectiveApi)) {
      return false;
    }
  }
  if (allowedHosts) {
    const baseUrlHost = normalizeBaseUrlHost(params.baseUrl ?? configuredProvider?.baseUrl);
    if (!baseUrlHost && !params.baseUrl && !configuredProvider?.baseUrl) {
      return true;
    }
    if (!baseUrlHost) {
      return false;
    }
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
  metadataSnapshot?: PluginMetadataSnapshot;
}): ManifestModelSuppressionResolver {
  const snapshot = params.metadataSnapshot ?? loadManifestMetadataSnapshot(params);
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
  const suppressions = new Map<string, PreparedManifestSuppression[]>();
  for (const entry of listManifestModelCatalogSuppressions({
    snapshot,
    config: params.config,
  })) {
    const prepared: PreparedManifestSuppression = {
      entry,
      allowedApis: entry.when?.providerConfigApiIn?.length
        ? new Set(entry.when.providerConfigApiIn.map(normalizeLowercaseStringOrEmpty))
        : undefined,
      allowedHosts: entry.when?.baseUrlHosts?.length
        ? new Set(entry.when.baseUrlHosts.map(normalizeSuppressionHost))
        : undefined,
    };
    // Preserve planner order when a route condition skips an earlier same-model rule.
    const rules = suppressions.get(entry.mergeKey);
    if (rules) {
      rules.push(prepared);
    } else {
      suppressions.set(entry.mergeKey, [prepared]);
    }
  }

  const resolver: ManifestModelSuppressionResolver = (input) => {
    const provider = normalizeLowercaseStringOrEmpty(input.provider);
    const modelId = normalizeLowercaseStringOrEmpty(input.id);
    if (!provider || !modelId) {
      return undefined;
    }
    const mergeKey = buildModelCatalogMergeKey(provider, modelId);
    const suppression = suppressions.get(mergeKey)?.find(
      (prepared) =>
        (!input.unconditionalOnly || !prepared.entry.when) &&
        manifestSuppressionMatchesConditions({
          suppression: prepared,
          provider,
          baseUrl: input.baseUrl,
          config: params.config,
        }),
    )?.entry;
    if (!suppression) {
      return undefined;
    }
    return {
      suppress: true,
      errorMessage: buildManifestSuppressionError({
        provider,
        modelId,
        reason: suppression.retirement
          ? `${suppression.reason ?? "This model has retired."} Run \`openclaw doctor --fix\` to ${suppression.retirement.replacedBy ? `replace it with ${suppression.retirement.replacedBy}` : "clear the retired override and use the default model"}.`
          : suppression.reason,
      }),
      ...(suppression.retirement ? { retirement: suppression.retirement } : {}),
    };
  };
  if (params.config) {
    compiled.byConfig.set(params.config, resolver);
  } else {
    compiled.unconfigured = resolver;
  }
  return resolver;
}
