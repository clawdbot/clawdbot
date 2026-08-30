import { isIP } from "node:net";
import type { RemoteModelCatalogPricing } from "@openclaw/model-catalog-core";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ModelCatalogCost } from "@openclaw/model-catalog-core/model-catalog-types";
import {
  createStaticProviderModelIdNormalizer,
  type ModelManifestNormalizationContext,
  normalizeProviderId,
} from "../agents/model-ref-shared.js";
import { createModelManifestPluginContext } from "../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isInstalledPluginEnabled } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataRegistryView } from "../plugins/plugin-metadata-snapshot.types.js";
import { planEffectiveModelCatalogRows } from "./index.js";
import { getRemoteModelCatalogPricing } from "./remote-overlay.js";

type PricingValue = RemoteModelCatalogPricing | ModelCatalogCost;
export type ModelPricingLookupContext = ModelManifestNormalizationContext & { agentId?: string };
type ExternalPricingPolicy = {
  external: boolean;
};
type PricingContext = {
  config: OpenClawConfig;
  normalization: ModelManifestNormalizationContext;
  normalizeKey: (provider: string, model: string) => string;
  catalog: ReadonlyMap<string, PricingValue>;
  hosted: Readonly<Record<string, RemoteModelCatalogPricing>>;
  normalizedHosted: ReadonlyMap<string, RemoteModelCatalogPricing>;
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  fingerprint: string;
};

const EMPTY_CONFIG: OpenClawConfig = {};
const pricingContextByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<PluginManifestRegistry, PricingContext>
>();

function normalizePolicy(
  policy: { external?: boolean } | undefined,
): ExternalPricingPolicy | undefined {
  if (!policy) {
    return undefined;
  }
  return { external: policy.external !== false };
}

function activeManifestRegistry(
  snapshot: PluginMetadataRegistryView,
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

function buildPricingContext(
  config: OpenClawConfig,
  snapshot: PluginMetadataRegistryView,
  normalization: ModelManifestNormalizationContext,
): PricingContext {
  const registry = activeManifestRegistry(snapshot, config);
  // Pricing is manifest data. Compile its policy once without activating provider
  // runtime, and use the same captured graph for local, catalog, and hosted keys.
  const normalizeModel = createStaticProviderModelIdNormalizer(normalization);
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
    for (const [provider, rawPolicy] of Object.entries(plugin.modelPricing?.providers ?? {})) {
      const policy = normalizePolicy(rawPolicy);
      if (policy) {
        policies.set(provider, policy);
      }
    }
  }
  const hosted = getRemoteModelCatalogPricing(config) ?? {};
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
    normalization: normalization.manifestPlugins?.flatMap((plugin) =>
      plugin.modelIdNormalization ? [plugin.modelIdNormalization] : [],
    ),
  });
  return {
    config,
    normalization,
    normalizeKey,
    catalog,
    hosted,
    normalizedHosted,
    policies,
    fingerprint,
  };
}

/** Captures one prepared metadata owner for every key in a pricing lookup. */
export function resolveModelPricingContext(params: ModelPricingLookupContext = {}): PricingContext {
  const config = params.config ?? EMPTY_CONFIG;
  const normalization = createModelManifestPluginContext({
    ...params,
    cfg: config,
    pluginMetadataSnapshot:
      params.pluginMetadataSnapshot ??
      (params.config
        ? undefined
        : getCurrentPluginMetadataSnapshot({ allowWorkspaceScopedSnapshot: true })),
    allowPluginNormalization: false,
  }).getContext();
  const snapshot =
    normalization.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config,
      workspaceDir: normalization.workspaceDir,
      allowWorkspaceScopedCurrent: true,
    });
  const byRegistry =
    pricingContextByConfig.get(config) ?? new WeakMap<PluginManifestRegistry, PricingContext>();
  const existing = byRegistry.get(snapshot.manifestRegistry);
  if (existing && existing.normalization.manifestPlugins === normalization.manifestPlugins) {
    return existing;
  }
  const context = buildPricingContext(config, snapshot, {
    ...normalization,
    pluginMetadataSnapshot: snapshot,
    manifestPlugins: normalization.manifestPlugins ?? snapshot.manifestRegistry.plugins,
  });
  byRegistry.set(snapshot.manifestRegistry, context);
  pricingContextByConfig.set(config, byRegistry);
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
  const catalogPricing = context.catalog.get(key);
  if (catalogPricing && hasKnownPricing(catalogPricing)) {
    return catalogPricing;
  }
  if (context.policies.get(provider)?.external === false) {
    return undefined;
  }
  const pricing =
    context.hosted[key] ??
    (context.policies.has(provider) ? undefined : context.normalizedHosted.get(key));
  return pricing && hasKnownPricing(pricing) ? pricing : undefined;
}

export function modelCatalogPricingFingerprint(
  config?: OpenClawConfig,
  normalization?: ModelPricingLookupContext,
  pricingContext?: PricingContext,
): string {
  const context = pricingContext ?? resolveModelPricingContext({ ...normalization, config });
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
