import type { RemoteModelCatalogPricing } from "@openclaw/model-catalog-core";
import type { ModelCatalogCost } from "@openclaw/model-catalog-core/model-catalog-types";
import { modelKey, normalizeModelRef } from "../agents/model-selection.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isInstalledPluginEnabled } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type {
  PluginManifestModelPricingModelIdTransform,
  PluginManifestModelPricingProvider,
  PluginManifestModelPricingSource,
} from "../plugins/manifest.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { planEffectiveModelCatalogRows } from "./index.js";
import { getRemoteModelCatalogPricing } from "./remote-overlay.js";

type PricingValue = RemoteModelCatalogPricing | ModelCatalogCost;
type ManifestPlugins = readonly PluginManifestRegistry["plugins"][number][];
type ExternalPricingSourcePolicy = {
  provider?: string;
  passthroughProviderModel?: boolean;
  modelIdTransforms: readonly PluginManifestModelPricingModelIdTransform[];
};
type ExternalPricingPolicy = {
  external: boolean;
  openRouter?: ExternalPricingSourcePolicy;
  liteLLM?: ExternalPricingSourcePolicy;
};
type PricingContext = {
  snapshot?: PluginMetadataSnapshot;
  catalog: ReadonlyMap<string, PricingValue>;
  hosted: Readonly<Record<string, RemoteModelCatalogPricing>>;
  normalizedHosted: ReadonlyMap<string, RemoteModelCatalogPricing>;
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  fingerprint: string;
};

const EMPTY_CONFIG: OpenClawConfig = {};
const pricingContextByConfig = new WeakMap<OpenClawConfig, PricingContext>();

function normalizeSource(
  source: PluginManifestModelPricingSource | false | undefined,
  manifestPlugins?: ManifestPlugins,
): ExternalPricingSourcePolicy | undefined {
  if (!source) {
    return undefined;
  }
  return {
    ...(source.provider
      ? {
          provider: normalizeModelRef(source.provider, "placeholder", { manifestPlugins }).provider,
        }
      : {}),
    ...(source.passthroughProviderModel ? { passthroughProviderModel: true } : {}),
    modelIdTransforms: source.modelIdTransforms ?? [],
  };
}

function normalizePolicy(
  policy: PluginManifestModelPricingProvider | undefined,
  manifestPlugins?: ManifestPlugins,
): ExternalPricingPolicy | undefined {
  if (!policy) {
    return undefined;
  }
  const openRouter = normalizeSource(policy.openRouter, manifestPlugins);
  const liteLLM = normalizeSource(policy.liteLLM, manifestPlugins);
  return {
    external: policy.external !== false,
    ...(openRouter ? { openRouter } : {}),
    ...(liteLLM ? { liteLLM } : {}),
  };
}

function activeManifestRegistry(
  snapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): PluginManifestRegistry {
  if (config.plugins?.enabled === false) {
    return { plugins: [], diagnostics: [] };
  }
  return {
    diagnostics: snapshot.manifestRegistry.diagnostics,
    plugins: snapshot.manifestRegistry.plugins.filter((plugin) =>
      isInstalledPluginEnabled(snapshot.index, plugin.id, config),
    ),
  };
}

function normalizedHostedKey(key: string, manifestPlugins?: ManifestPlugins): string | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) {
    return undefined;
  }
  const normalized = normalizeModelRef(key.slice(0, slash), key.slice(slash + 1), {
    manifestPlugins,
  });
  return modelKey(normalized.provider, normalized.model);
}

function buildPricingContext(config: OpenClawConfig): PricingContext {
  let snapshot: PluginMetadataSnapshot | undefined;
  try {
    snapshot = resolvePluginMetadataSnapshot({
      config,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
    });
  } catch {
    snapshot = undefined;
  }
  const registry = snapshot
    ? activeManifestRegistry(snapshot, config)
    : ({ plugins: [], diagnostics: [] } satisfies PluginManifestRegistry);
  const catalog = new Map<string, PricingValue>();
  for (const row of planEffectiveModelCatalogRows({ registry, config }).rows) {
    if (row.cost) {
      catalog.set(modelKey(row.provider, row.id), row.cost);
    }
  }
  const policies = new Map<string, ExternalPricingPolicy>();
  for (const plugin of registry.plugins) {
    for (const [provider, rawPolicy] of Object.entries(plugin.modelPricing?.providers ?? {})) {
      const policy = normalizePolicy(rawPolicy, snapshot?.plugins);
      if (policy) {
        policies.set(provider, policy);
      }
    }
  }
  const hosted = getRemoteModelCatalogPricing(config) ?? {};
  const normalizedHosted = new Map<string, RemoteModelCatalogPricing>();
  for (const [key, pricing] of Object.entries(hosted).toSorted(([a], [b]) => a.localeCompare(b))) {
    const normalized = normalizedHostedKey(key, snapshot?.plugins);
    if (normalized && !normalizedHosted.has(normalized)) {
      normalizedHosted.set(normalized, pricing);
    }
  }
  const fingerprint = JSON.stringify({
    catalog: [...catalog.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    hosted: Object.entries(hosted).toSorted(([a], [b]) => a.localeCompare(b)),
  });
  return { snapshot, catalog, hosted, normalizedHosted, policies, fingerprint };
}

function getPricingContext(config: OpenClawConfig): PricingContext {
  const existing = pricingContextByConfig.get(config);
  if (existing) {
    return existing;
  }
  const context = buildPricingContext(config);
  pricingContextByConfig.set(config, context);
  return context;
}

function hasKnownPricing(pricing: PricingValue): boolean {
  return (
    Boolean(pricing.tieredPricing?.length) ||
    (pricing.input ?? 0) > 0 ||
    (pricing.output ?? 0) > 0 ||
    (pricing.cacheRead ?? 0) > 0 ||
    (pricing.cacheWrite ?? 0) > 0
  );
}

function applyModelIdTransforms(
  model: string,
  transforms: readonly PluginManifestModelPricingModelIdTransform[],
): string[] {
  const variants = new Set([model]);
  for (const transform of transforms) {
    if (transform !== "version-dots") {
      continue;
    }
    for (const variant of [...variants]) {
      variants.add(
        variant
          .replace(/^claude-(\d+)-(\d+)-/u, "claude-$1.$2-")
          .replace(/^claude-([a-z]+)-(\d+)-(\d+)$/u, "claude-$1-$2.$3"),
      );
    }
  }
  return [...variants];
}

function buildHostedPricingCandidates(params: {
  provider: string;
  model: string;
  source: "openRouter" | "liteLLM";
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  manifestPlugins?: ManifestPlugins;
  seen?: Set<string>;
}): string[] {
  const key = modelKey(params.provider, params.model);
  const seen = params.seen ?? new Set<string>();
  if (seen.has(key)) {
    return [];
  }
  const nextSeen = new Set(seen).add(key);
  const policy = params.policies.get(params.provider);
  if (policy?.external === false) {
    return [];
  }
  const sourcePolicy = policy?.[params.source];
  if (policy && !sourcePolicy) {
    return [];
  }
  const externalProvider = sourcePolicy?.provider ?? params.provider;
  const candidates = new Set(
    applyModelIdTransforms(params.model, sourcePolicy?.modelIdTransforms ?? []).map((model) =>
      modelKey(externalProvider, model),
    ),
  );
  if (sourcePolicy?.passthroughProviderModel && params.model.includes("/")) {
    const slash = params.model.indexOf("/");
    const nested = normalizeModelRef(params.model.slice(0, slash), params.model.slice(slash + 1), {
      manifestPlugins: params.manifestPlugins,
    });
    for (const candidate of buildHostedPricingCandidates({
      provider: nested.provider,
      model: nested.model,
      source: params.source,
      policies: params.policies,
      manifestPlugins: params.manifestPlugins,
      seen: nextSeen,
    })) {
      candidates.add(candidate);
    }
  }
  return [...candidates];
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  ) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[0-1])\./u.test(host);
}

function isPrivateOrLoopbackUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return isPrivateOrLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function findConfiguredModel(
  config: OpenClawConfig,
  provider: string,
  model: string,
  manifestPlugins?: ManifestPlugins,
): ModelDefinitionConfig | undefined {
  return config.models?.providers?.[provider]?.models?.find((entry) => {
    const normalized = normalizeModelRef(provider, entry.id, { manifestPlugins });
    return modelKey(normalized.provider, normalized.model) === modelKey(provider, model);
  });
}

function allowsHostedPricing(
  config: OpenClawConfig,
  provider: string,
  model: string,
  manifestPlugins?: ManifestPlugins,
): boolean {
  const providerConfig = config.models?.providers?.[provider];
  const configuredModel = findConfiguredModel(config, provider, model, manifestPlugins);
  return !(
    isPrivateOrLoopbackUrl(configuredModel?.baseUrl) ||
    isPrivateOrLoopbackUrl(providerConfig?.baseUrl)
  );
}

export function resolveCatalogModelPricing(params: {
  config?: OpenClawConfig;
  provider: string;
  model: string;
}): PricingValue | undefined {
  const config = params.config ?? EMPTY_CONFIG;
  const context = getPricingContext(config);
  const normalized = normalizeModelRef(params.provider, params.model, {
    manifestPlugins: context.snapshot?.plugins,
  });
  const pricing = context.catalog.get(modelKey(normalized.provider, normalized.model));
  return pricing && hasKnownPricing(pricing) ? pricing : undefined;
}

export function resolveHostedModelPricing(params: {
  config?: OpenClawConfig;
  provider: string;
  model: string;
}): RemoteModelCatalogPricing | undefined {
  const config = params.config ?? EMPTY_CONFIG;
  const context = getPricingContext(config);
  const normalized = normalizeModelRef(params.provider, params.model, {
    manifestPlugins: context.snapshot?.plugins,
  });
  if (
    !allowsHostedPricing(config, normalized.provider, normalized.model, context.snapshot?.plugins)
  ) {
    return undefined;
  }
  const candidates = [
    ...buildHostedPricingCandidates({
      provider: normalized.provider,
      model: normalized.model,
      source: "openRouter",
      policies: context.policies,
      manifestPlugins: context.snapshot?.plugins,
    }),
    ...buildHostedPricingCandidates({
      provider: normalized.provider,
      model: normalized.model,
      source: "liteLLM",
      policies: context.policies,
      manifestPlugins: context.snapshot?.plugins,
    }),
  ];
  for (const candidate of new Set(candidates)) {
    const exact = context.hosted[candidate];
    if (exact) {
      return exact;
    }
  }
  for (const candidate of new Set(candidates)) {
    const normalizedCandidate = normalizedHostedKey(candidate, context.snapshot?.plugins);
    const matched = normalizedCandidate
      ? context.normalizedHosted.get(normalizedCandidate)
      : undefined;
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

export function modelCatalogPricingFingerprint(config?: OpenClawConfig): string {
  return getPricingContext(config ?? EMPTY_CONFIG).fingerprint;
}
