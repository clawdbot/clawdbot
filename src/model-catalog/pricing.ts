import { isIP } from "node:net";
import type { RemoteModelCatalogPricing } from "@openclaw/model-catalog-core";
import { MODEL_PRICING_SOURCES } from "@openclaw/model-catalog-core/model-catalog-pricing";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ModelCatalogCost } from "@openclaw/model-catalog-core/model-catalog-types";
import {
  createStaticProviderModelIdNormalizer,
  normalizeProviderId,
} from "../agents/model-ref-shared.js";
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
type ExternalPricingPolicy = {
  external: boolean;
  authoritative: boolean;
};
type PricingContext = {
  config: OpenClawConfig;
  normalizeKey: (provider: string, model: string) => string;
  catalog: ReadonlyMap<string, PricingValue>;
  hosted: Readonly<Record<string, RemoteModelCatalogPricing>>;
  normalizedHosted: ReadonlyMap<string, RemoteModelCatalogPricing>;
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  fingerprint: string;
};

const EMPTY_CONFIG: OpenClawConfig = {};
const pricingContextByConfig = new WeakMap<OpenClawConfig, PricingContext>();

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

function normalizedHostedKey(
  key: string,
  normalizeKey: PricingContext["normalizeKey"],
): string | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) {
    return undefined;
  }
  return normalizeKey(key.slice(0, slash), key.slice(slash + 1));
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
  // Pricing reuses prepared static policies without activating provider runtime.
  const normalizeModel = createStaticProviderModelIdNormalizer({
    manifestPlugins: snapshot ?? [],
  });
  const normalizeKey = (provider: string, model: string) => {
    const providerId = normalizeProviderId(provider);
    return buildModelCatalogRef(providerId, normalizeModel(providerId, model.trim()));
  };
  const catalog = new Map<string, PricingValue>();
  for (const row of planEffectiveModelCatalogRows({ registry, config }).rows) {
    if (row.cost) {
      catalog.set(buildModelCatalogRef(row.provider, row.id), row.cost);
    }
  }
  const policies = new Map<string, ExternalPricingPolicy>();
  for (const plugin of registry.plugins) {
    for (const [provider, policy] of Object.entries(plugin.modelPricing?.providers ?? {})) {
      policies.set(provider, {
        external: policy.external !== false,
        authoritative: MODEL_PRICING_SOURCES.some(
          ({ id, authoritative }) => authoritative && Boolean(policy[id]),
        ),
      });
    }
  }
  // Hosted aliases are policy-resolved against installed manifests. If that metadata is
  // unavailable, fail closed instead of treating every provider as policy-free.
  const hosted = snapshot ? (getRemoteModelCatalogPricing(config) ?? {}) : {};
  const normalizedHosted = new Map<string, RemoteModelCatalogPricing>();
  for (const [key, pricing] of Object.entries(hosted).toSorted(([a], [b]) => a.localeCompare(b))) {
    const normalized = normalizedHostedKey(key, normalizeKey);
    if (normalized && !normalizedHosted.has(normalized)) {
      normalizedHosted.set(normalized, pricing);
    }
  }
  const fingerprint = JSON.stringify({
    catalog: [...catalog.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    hosted: Object.entries(hosted).toSorted(([a], [b]) => a.localeCompare(b)),
    normalizedHosted: [...normalizedHosted.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    policies: [...policies.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    normalization: [...(snapshot?.owners.modelIdNormalizationPolicies ?? [])].toSorted(([a], [b]) =>
      a.localeCompare(b),
    ),
  });
  return { config, normalizeKey, catalog, hosted, normalizedHosted, policies, fingerprint };
}

/** Reuses the static pricing policy captured for this config. */
export function resolveModelPricingContext(config: OpenClawConfig = EMPTY_CONFIG): PricingContext {
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

/** Resolves catalog-first pricing for a key prepared by this metadata context. */
export function resolveModelPricing(
  context: PricingContext,
  key: string,
): PricingValue | undefined {
  const provider = key.slice(0, key.indexOf("/"));
  const providerConfig = context.config.models?.providers?.[provider];
  const configuredModel = providerConfig?.models?.find(
    (entry) => context.normalizeKey(provider, entry.id) === key,
  );
  if (
    isPrivateOrLoopbackUrl(configuredModel?.baseUrl) ||
    isPrivateOrLoopbackUrl(providerConfig?.baseUrl)
  ) {
    return undefined;
  }
  const catalog = context.catalog.get(key);
  if (catalog && hasKnownPricing(catalog)) {
    return catalog;
  }
  const policy = context.policies.get(provider);
  if (policy?.external === false) {
    return undefined;
  }
  const hosted = context.hosted[key] ?? (policy ? undefined : context.normalizedHosted.get(key));
  // The publisher retains validated native zeros under exact owner keys. Catalog
  // placeholders and normalized aliases cannot establish an authoritative free rate.
  return hosted && (hasKnownPricing(hosted) || policy?.authoritative) ? hosted : undefined;
}

export function modelCatalogPricingFingerprint(context: PricingContext): string {
  const resolvedConfig = context.config;
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
