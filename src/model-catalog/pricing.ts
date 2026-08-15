import { isIP } from "node:net";
import type { RemoteModelCatalogPricing } from "@openclaw/model-catalog-core";
import type { ModelCatalogCost } from "@openclaw/model-catalog-core/model-catalog-types";
import { modelKey, normalizeModelRef } from "../agents/model-selection.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isInstalledPluginEnabled } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { planEffectiveModelCatalogRows } from "./index.js";
import { getRemoteModelCatalogPricing } from "./remote-overlay.js";

type PricingValue = RemoteModelCatalogPricing | ModelCatalogCost;
type ManifestPlugins = readonly PluginManifestRegistry["plugins"][number][];
type ExternalPricingPolicy = {
  external: boolean;
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

function normalizePolicy(
  policy: { external?: boolean } | undefined,
): ExternalPricingPolicy | undefined {
  if (!policy) {
    return undefined;
  }
  return { external: policy.external !== false };
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
      const policy = normalizePolicy(rawPolicy);
      if (policy) {
        policies.set(provider, policy);
      }
    }
  }
  // Hosted aliases are policy-resolved against installed manifests. If that metadata is
  // unavailable, fail closed instead of treating every provider as policy-free.
  const hosted = snapshot ? (getRemoteModelCatalogPricing(config) ?? {}) : {};
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
    normalizedHosted: [...normalizedHosted.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    policies: [...policies.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
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
    Boolean(
      pricing.tieredPricing?.some(
        (tier) => tier.input > 0 || tier.output > 0 || tier.cacheRead > 0 || tier.cacheWrite > 0,
      ),
    ) ||
    (pricing.input ?? 0) > 0 ||
    (pricing.output ?? 0) > 0 ||
    (pricing.cacheRead ?? 0) > 0 ||
    (pricing.cacheWrite ?? 0) > 0
  );
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
    host.endsWith(".local")
  ) {
    return true;
  }
  const addressFamily = isIP(host);
  if (addressFamily === 6) {
    return (
      host === "::1" ||
      host === "0:0:0:0:0:0:0:1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    );
  }
  if (addressFamily === 4) {
    return (
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./u.test(host)
    );
  }
  return false;
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
  if (
    !allowsHostedPricing(config, normalized.provider, normalized.model, context.snapshot?.plugins)
  ) {
    return undefined;
  }
  const pricing = context.catalog.get(modelKey(normalized.provider, normalized.model));
  return pricing && hasKnownPricing(pricing) ? pricing : undefined;
}

export function resolveHostedModelPricing(params: {
  config?: OpenClawConfig;
  provider: string;
  model: string;
}): PricingValue | undefined {
  const config = params.config ?? EMPTY_CONFIG;
  const context = getPricingContext(config);
  const normalized = normalizeModelRef(params.provider, params.model, {
    manifestPlugins: context.snapshot?.plugins,
  });
  if (
    context.policies.get(normalized.provider)?.external === false ||
    !allowsHostedPricing(config, normalized.provider, normalized.model, context.snapshot?.plugins)
  ) {
    return undefined;
  }
  const key = modelKey(normalized.provider, normalized.model);
  const pricing =
    context.hosted[key] ??
    (context.policies.has(normalized.provider) ? undefined : context.normalizedHosted.get(key));
  return pricing && hasKnownPricing(pricing) ? pricing : undefined;
}

export function modelCatalogPricingFingerprint(config?: OpenClawConfig): string {
  const resolvedConfig = config ?? EMPTY_CONFIG;
  const context = getPricingContext(resolvedConfig);
  const configuredEndpoints = Object.entries(resolvedConfig.models?.providers ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([provider, providerConfig]) => ({
      provider,
      baseUrl: providerConfig.baseUrl,
      models: (providerConfig.models ?? [])
        .map((model) => ({ id: model.id, baseUrl: model.baseUrl }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    }));
  return JSON.stringify({ pricing: context.fingerprint, configuredEndpoints });
}
