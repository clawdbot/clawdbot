/**
 * Shared token/cost formatting and pricing lookup helpers for CLI, TUI, gateway, and status output.
 * Keep this module synchronous; request paths call it while rendering usage summaries.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeBuiltInProviderModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentEntries,
  resolveAgentDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import type { NormalizedUsage } from "../agents/usage.js";
import { resolveStateDir } from "../config/paths.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  modelCatalogPricingFingerprint,
  resolveModelPricing,
  resolveModelPricingContext,
  type ModelPricingLookupContext,
} from "../model-catalog/pricing.js";
import {
  normalizeModelCostConfig,
  normalizeResolvedPricing,
  type ModelCostConfig,
  type PricingTier,
  type RawModelCostConfig,
} from "./usage-format-pricing.js";
export { formatTokenCount } from "./token-format.js";
export type { ModelCostConfig } from "./usage-format-pricing.js";

type UsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type ModelsJsonCostCache = {
  providers: Record<string, ModelProviderConfig> | undefined;
  rawEntries?: Map<string, ModelCostConfig>;
};
type ModelKeyNormalizer = (provider: string, model: string) => string;

type ProviderCostIndexSource = {
  fingerprint: string;
  model: NonNullable<ModelProviderConfig["models"]>[number];
  providerKey: string;
  rawCost: RawModelCostConfig;
};

type ProviderCostIndex = {
  entries: Map<string, ModelCostConfig>;
  sources: Map<string, ProviderCostIndexSource>;
  structureFingerprint: string;
};

const EMPTY_PROVIDER_COST_INDEX = new Map<string, ModelCostConfig>();
const MODELS_JSON_COST_CACHE_LIMIT = 128;

let modelsJsonCostCacheByAgentDir = new Map<string, ModelsJsonCostCache>();
let providerCostIndexByConfig = new WeakMap<
  Record<string, ModelProviderConfig>,
  ProviderCostIndex
>();
let sortedPricingTiersByInput = new WeakMap<PricingTier[], PricingTier[]>();

/** Formats a USD amount for usage summaries, keeping tiny costs visible. */
export function formatUsd(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

function normalizeRawModelKey(provider: string, model: string): string {
  const providerId = normalizeProviderId(provider);
  // Built-in aliases remain valid; a provider-shaped prefix alone is model data.
  return buildModelCatalogRef(
    providerId,
    normalizeBuiltInProviderModelId(providerId, model.trim()),
  );
}

function isRawModelCostConfig(value: unknown): value is RawModelCostConfig {
  return value !== null && typeof value === "object";
}

function buildProviderCostStructureFingerprint(
  providers: Record<string, ModelProviderConfig> | undefined,
): string {
  if (!providers) {
    return "";
  }
  return Object.entries(providers)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([providerKey, providerConfig]) =>
      (providerConfig?.models ?? []).map(
        (model) =>
          `${providerKey}\0${model.id}\0${isRawModelCostConfig(model.cost) ? "cost" : "metadata"}`,
      ),
    )
    .join("\0");
}

function buildProviderCostIndexBundle(
  providers: Record<string, ModelProviderConfig> | undefined,
  normalizeKey: ModelKeyNormalizer = normalizeRawModelKey,
): ProviderCostIndex {
  const entries = new Map<string, ModelCostConfig>();
  const sources = new Map<string, ProviderCostIndexSource>();
  const structureFingerprint = buildProviderCostStructureFingerprint(providers);
  if (!providers) {
    return { entries, sources, structureFingerprint };
  }
  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    const normalizedProvider = normalizeProviderId(providerKey);
    for (const model of providerConfig?.models ?? []) {
      if (!isRawModelCostConfig(model.cost)) {
        continue;
      }
      const key = normalizeKey(normalizedProvider, model.id);
      const rawCost = model.cost;
      entries.set(key, normalizeModelCostConfig(rawCost));
      sources.set(key, {
        fingerprint: buildModelCostFingerprint(rawCost),
        model,
        providerKey,
        rawCost,
      });
    }
  }
  return { entries, sources, structureFingerprint };
}

function getProviderCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  normalizeKey?: ModelKeyNormalizer,
): Map<string, ModelCostConfig> {
  if (!providers) {
    return EMPTY_PROVIDER_COST_INDEX;
  }
  if (normalizeKey) {
    // Normalized indexes belong to this lookup's captured metadata generation.
    // Only raw indexes can be shared by mutable provider-config identity alone.
    return buildProviderCostIndexBundle(providers, normalizeKey).entries;
  }
  let index = providerCostIndexByConfig.get(providers);
  if (
    !index ||
    refreshProviderCostIndexMutations(index, providers) === "rebuild" ||
    index.structureFingerprint !== buildProviderCostStructureFingerprint(providers)
  ) {
    index = buildProviderCostIndexBundle(providers);
    providerCostIndexByConfig.set(providers, index);
  }
  return index.entries;
}

function loadModelsJsonCostIndex(options?: {
  agentDir?: string;
  normalizeKey?: ModelKeyNormalizer;
}): Map<string, ModelCostConfig> {
  const agentDir = options?.agentDir;
  if (!agentDir) {
    return EMPTY_PROVIDER_COST_INDEX;
  }
  const modelsPath = path.join(agentDir, "models.json");
  try {
    let modelsJsonCostCache = modelsJsonCostCacheByAgentDir.get(agentDir);
    if (!modelsJsonCostCache) {
      const parsed = tryReadJsonSync<{
        providers?: Record<string, ModelProviderConfig>;
      }>(modelsPath);
      if (!parsed) {
        return EMPTY_PROVIDER_COST_INDEX;
      }
      modelsJsonCostCache = {
        providers: parsed?.providers,
      };
      pruneMapToMaxSize(modelsJsonCostCacheByAgentDir, MODELS_JSON_COST_CACHE_LIMIT - 1);
      modelsJsonCostCacheByAgentDir.set(agentDir, modelsJsonCostCache);
    }

    return options?.normalizeKey
      ? getProviderCostIndex(modelsJsonCostCache.providers, options.normalizeKey)
      : (modelsJsonCostCache.rawEntries ??= getProviderCostIndex(modelsJsonCostCache.providers));
  } catch {
    return EMPTY_PROVIDER_COST_INDEX;
  }
}

function resolveCostAgentDir(
  config?: OpenClawConfig,
  agentDir?: string,
  agentId?: string,
): string | undefined {
  if (agentDir) {
    return agentDir;
  }
  if (agentId) {
    return resolveAgentDir(config ?? {}, agentId);
  }
  if (config && listAgentEntries(config).length > 0) {
    const defaultAgentId = tryResolveDefaultAgentId(config);
    return defaultAgentId ? resolveAgentDir(config, defaultAgentId) : undefined;
  }
  // Config-less and pricing-only lookups are shipped APIs for the historical
  // main models.json. Full runtime configs resolve their roster default above.
  return path.join(resolveStateDir(), "agents", "main", "agent");
}

function stableCostFingerprintValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableCostFingerprintValue(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableCostFingerprintValue(record[key])}`)
    .join(",")}}`;
}

function buildModelCostFingerprint(cost: RawModelCostConfig): string {
  const tierFingerprint = Array.isArray(cost.tieredPricing)
    ? cost.tieredPricing.flatMap((tier) => {
        const range = Array.isArray(tier.range) ? tier.range : [];
        return [tier.input, tier.output, tier.cacheRead, tier.cacheWrite, ...range];
      })
    : [];
  return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, ...tierFingerprint].join("|");
}

function isProviderCostSourceCurrent(
  providers: Record<string, ModelProviderConfig>,
  source: ProviderCostIndexSource,
  key: string,
): boolean {
  const providerConfig = providers[source.providerKey];
  if (!providerConfig?.models?.includes(source.model)) {
    return false;
  }
  return normalizeRawModelKey(source.providerKey, source.model.id) === key;
}

function refreshProviderCostIndexEntry(
  index: ProviderCostIndex,
  key: string,
  providers?: Record<string, ModelProviderConfig>,
): "current" | "rebuild" {
  const source = index.sources.get(key);
  if (!source) {
    return "current";
  }
  if (providers && !isProviderCostSourceCurrent(providers, source, key)) {
    return "rebuild";
  }
  if (!isRawModelCostConfig(source.model.cost)) {
    return "rebuild";
  }
  if (source.model.cost !== source.rawCost) {
    source.rawCost = source.model.cost;
  }
  const fingerprint = buildModelCostFingerprint(source.rawCost);
  if (source.fingerprint === fingerprint) {
    return "current";
  }
  source.fingerprint = fingerprint;
  index.entries.set(key, normalizeModelCostConfig(source.rawCost));
  return "current";
}

function refreshProviderCostIndexMutations(
  index: ProviderCostIndex,
  providers?: Record<string, ModelProviderConfig>,
): "current" | "rebuild" {
  for (const key of index.sources.keys()) {
    if (refreshProviderCostIndexEntry(index, key, providers) === "rebuild") {
      return "rebuild";
    }
  }
  return "current";
}

function hasProviderCostSourceForKey(
  providers: Record<string, ModelProviderConfig>,
  key: string,
): boolean {
  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    const normalizedProvider = normalizeProviderId(providerKey);
    for (const model of providerConfig?.models ?? []) {
      if (!isRawModelCostConfig(model.cost)) {
        continue;
      }
      if (normalizeRawModelKey(normalizedProvider, model.id) === key) {
        return true;
      }
    }
  }
  return false;
}

function getProviderCostFromIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  key: string,
  normalizeKey?: ModelKeyNormalizer,
): ModelCostConfig | undefined {
  if (!providers) {
    return undefined;
  }
  if (normalizeKey) {
    return buildProviderCostIndexBundle(providers, normalizeKey).entries.get(key);
  }
  let index = providerCostIndexByConfig.get(providers);
  if (!index) {
    index = buildProviderCostIndexBundle(providers);
    providerCostIndexByConfig.set(providers, index);
  }
  const sourceMissingWithStructuralChange =
    !index.sources.has(key) &&
    index.structureFingerprint !== buildProviderCostStructureFingerprint(providers);
  const sourceMissingWithNewCost =
    !index.sources.has(key) && hasProviderCostSourceForKey(providers, key);
  if (
    refreshProviderCostIndexEntry(index, key, providers) === "rebuild" ||
    sourceMissingWithStructuralChange ||
    sourceMissingWithNewCost
  ) {
    const rebuilt = buildProviderCostIndexBundle(providers);
    providerCostIndexByConfig.set(providers, rebuilt);
    return rebuilt.entries.get(key);
  }
  return index.entries.get(key);
}

function serializeCostIndex(
  entries: Map<string, ModelCostConfig>,
): Array<[string, ModelCostConfig]> {
  return Array.from(entries.entries()).toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * Fingerprints all model-pricing sources that can affect usage cost estimates.
 * Consumers cache this value to know when resolved cost entries need recomputation.
 */
export function resolveModelCostConfigFingerprint(
  config?: OpenClawConfig,
  agentDir?: string,
  normalization?: ModelPricingLookupContext,
): string {
  const resolvedAgentDir = resolveCostAgentDir(config, agentDir, normalization?.agentId);
  const pricingContext = resolveModelPricingContext({ ...normalization, config });
  const serialized = stableCostFingerprintValue({
    configuredRaw: serializeCostIndex(getProviderCostIndex(config?.models?.providers)),
    configuredNormalized: serializeCostIndex(
      getProviderCostIndex(config?.models?.providers, pricingContext.normalizeKey),
    ),
    modelsJsonRaw: serializeCostIndex(
      loadModelsJsonCostIndex({
        agentDir: resolvedAgentDir,
      }),
    ),
    modelsJsonNormalized: serializeCostIndex(
      loadModelsJsonCostIndex({
        agentDir: resolvedAgentDir,
        normalizeKey: pricingContext.normalizeKey,
      }),
    ),
    catalogPricing: modelCatalogPricingFingerprint(config, normalization, pricingContext),
  });
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Resolves pricing for a provider/model pair from local models.json, configured models, then gateway cache.
 * Direct keys win before plugin normalization so configured pricing does not trigger provider discovery.
 */
export function resolveModelCostConfig(
  params: ModelPricingLookupContext & {
    provider?: string;
    model?: string;
    agentDir?: string;
    allowPluginNormalization?: boolean;
  },
): ModelCostConfig | undefined {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    return undefined;
  }
  const rawKey = normalizeRawModelKey(provider, model);
  const agentDir = resolveCostAgentDir(params.config, params.agentDir, params.agentId);
  // Favor direct configured keys first so local pricing/status lookups stay
  // synchronous and do not drag plugin/provider discovery into the hot path.
  const rawModelsJsonCost = loadModelsJsonCostIndex({
    agentDir,
  }).get(rawKey);
  if (rawModelsJsonCost) {
    return rawModelsJsonCost;
  }

  const rawConfiguredCost = getProviderCostFromIndex(params.config?.models?.providers, rawKey);
  if (rawConfiguredCost) {
    return rawConfiguredCost;
  }

  if (params.allowPluginNormalization === false) {
    return undefined;
  }

  const pricingContext = resolveModelPricingContext(params);
  const key = pricingContext.normalizeKey(provider, model);
  const modelsJsonCost = loadModelsJsonCostIndex({
    agentDir,
    normalizeKey: pricingContext.normalizeKey,
  }).get(key);
  if (modelsJsonCost) {
    return modelsJsonCost;
  }

  const configuredCost = getProviderCostFromIndex(
    params.config?.models?.providers,
    key,
    pricingContext.normalizeKey,
  );
  if (configuredCost) {
    return configuredCost;
  }

  const pricing = resolveModelPricing(pricingContext, key);
  return pricing ? normalizeResolvedPricing(pricing) : undefined;
}

const toNumber = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function selectPricingTier(tiers: PricingTier[], input: number): PricingTier | undefined {
  const sortedTiers = getSortedPricingTiers(tiers);
  if (sortedTiers.length === 0) {
    return undefined;
  }
  if (input <= 0) {
    return sortedTiers[0];
  }

  for (const tier of sortedTiers) {
    const [start, end] = tier.range;
    if (input >= start && input < end) {
      return tier;
    }
  }

  for (let index = sortedTiers.length - 1; index >= 0; index -= 1) {
    const tier = expectDefined(sortedTiers[index], "sorted tiers entry at index");
    if (input >= tier.range[0]) {
      return tier;
    }
  }

  return sortedTiers[0];
}

function getSortedPricingTiers(tiers: PricingTier[]): PricingTier[] {
  const cached = sortedPricingTiersByInput.get(tiers);
  if (cached) {
    return cached;
  }
  const sorted = tiers.toSorted((a, b) => a.range[0] - b.range[0]);
  sortedPricingTiersByInput.set(tiers, sorted);
  return sorted;
}

function computeTieredCost(
  tiers: PricingTier[],
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const tier = selectPricingTier(tiers, input);
  if (!tier) {
    return 0;
  }

  return (
    input * tier.input +
    output * tier.output +
    cacheRead * tier.cacheRead +
    cacheWrite * tier.cacheWrite
  );
}

/**
 * Estimates USD usage cost from normalized token totals.
 * Tiered pricing selects one whole-request tier by input size; it does not blend tiers.
 */
export function estimateUsageCost(params: {
  usage?: NormalizedUsage | UsageTotals | null;
  cost?: ModelCostConfig;
}): number | undefined {
  const usage = params.usage;
  const cost = params.cost;
  if (!usage || !cost) {
    return undefined;
  }
  const input = toNumber(usage.input);
  const output = toNumber(usage.output);
  const cacheRead = toNumber(usage.cacheRead);
  const cacheWrite = toNumber(usage.cacheWrite);

  let total: number;
  if (cost.tieredPricing && cost.tieredPricing.length > 0) {
    total = computeTieredCost(cost.tieredPricing, input, output, cacheRead, cacheWrite);
  } else {
    total =
      input * cost.input +
      output * cost.output +
      cacheRead * cost.cacheRead +
      cacheWrite * cost.cacheWrite;
  }

  if (!Number.isFinite(total)) {
    return undefined;
  }
  return total / 1_000_000;
}

export function resetUsageFormatCachesForTest(): void {
  modelsJsonCostCacheByAgentDir = new Map();
  providerCostIndexByConfig = new WeakMap();
  sortedPricingTiersByInput = new WeakMap();
}
