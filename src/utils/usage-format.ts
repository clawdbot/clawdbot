/**
 * Shared token/cost formatting and pricing lookup helpers for CLI, TUI, gateway, and status output.
 * Keep this module synchronous; request paths call it while rendering usage summaries.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  calculateUsageCost,
  normalizeModelCostConfig,
  normalizeResolvedPricing,
  type ModelCostConfig,
  type RawModelCostConfig,
} from "@openclaw/llm-core";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeBuiltInProviderModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentEntries,
  resolveAgentDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import { normalizeProviderMapKeys } from "../agents/models-config.merge.js";
import type { NormalizedUsage } from "../agents/usage.js";
import { mergeModelCost } from "../config/model-cost.js";
import { resolveStateDir } from "../config/paths.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { UsageCacheStatus } from "../infra/session-cost-usage.types.js";
import {
  modelCatalogPricingFingerprint,
  resolveModelPricing,
  resolveModelPricingContext,
} from "../model-catalog/pricing.js";
export { formatTokenCount } from "./token-format.js";
export type { ModelCostConfig } from "@openclaw/llm-core";

type ModelKeyNormalizer = (provider: string, model: string) => string;
type ModelsJsonCostCache = {
  providers: Record<string, ModelProviderConfig> | undefined;
  entries: WeakMap<ModelKeyNormalizer, Map<string, RawModelCostConfig>>;
};

type ProviderCostIndexSource = {
  model: NonNullable<ModelProviderConfig["models"]>[number];
  providerKey: string;
  modelId: string;
};

type ProviderCostIndex = {
  entries: Map<string, RawModelCostConfig>;
  sources: Map<string, ProviderCostIndexSource["model"][]>;
  structure: ProviderCostIndexSource[];
};

const EMPTY_PROVIDER_COST_INDEX = new Map<string, RawModelCostConfig>();
const MODELS_JSON_COST_CACHE_LIMIT = 128;

let modelsJsonCostCacheByAgentDir = new Map<string, ModelsJsonCostCache>();
let providerCostIndexByNormalizer = new WeakMap<
  ModelKeyNormalizer,
  WeakMap<Record<string, ModelProviderConfig>, ProviderCostIndex>
>();

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

/** Prefix aggregate totals with their recorded cache-readiness notice. */
export function formatCostUsageCachePrefix(cacheStatus?: UsageCacheStatus): string {
  return cacheStatus && cacheStatus.status !== "fresh"
    ? `Usage totals may be incomplete (${cacheStatus.status}). Run this command again later.\n`
    : "";
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

function collectProviderCostSources(
  providers: Record<string, ModelProviderConfig>,
): ProviderCostIndexSource[] {
  return Object.entries(normalizeProviderMapKeys(providers)).flatMap(([providerKey, provider]) =>
    (provider?.models ?? []).map((model) => ({ providerKey, model, modelId: model.id })),
  );
}

function buildProviderCostIndexBundle(
  structure: ProviderCostIndexSource[],
  normalizeKey: ModelKeyNormalizer,
): ProviderCostIndex {
  const sources: ProviderCostIndex["sources"] = new Map();
  for (const { providerKey, model, modelId } of structure) {
    const key = normalizeKey(providerKey, modelId);
    const rows = sources.get(key) ?? [];
    rows.push(model);
    sources.set(key, rows);
  }
  return { entries: new Map(), sources, structure };
}

function refreshProviderCostIndexEntry(index: ProviderCostIndex, key: string): void {
  // Retain every row, including metadata-only rows, so edits cannot resurrect
  // a later duplicate's price or turn a removed cost into an authored pin.
  let cost: RawModelCostConfig | undefined;
  for (const model of index.sources.get(key) ?? []) {
    if (isRawModelCostConfig(model.cost)) {
      cost = mergeModelCost(model.cost, cost);
    }
  }
  if (cost) {
    index.entries.set(key, cost);
  } else {
    index.entries.delete(key);
  }
}

function getProviderCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  normalizeKey: ModelKeyNormalizer = normalizeRawModelKey,
  key?: string,
): Map<string, RawModelCostConfig> {
  if (!providers) {
    return EMPTY_PROVIDER_COST_INDEX;
  }
  // Captured policy owns normalized keys; provider config identity alone is insufficient.
  let cache = providerCostIndexByNormalizer.get(normalizeKey);
  if (!cache) {
    cache = new WeakMap();
    providerCostIndexByNormalizer.set(normalizeKey, cache);
  }
  let index = cache.get(providers);
  const structure = collectProviderCostSources(providers);
  // Identity and order matter even when duplicate rows have the same id.
  // Prices stay live on their source rows; only membership/id changes rebuild keys.
  if (
    !index ||
    index.structure.length !== structure.length ||
    index.structure.some((source, position) => {
      const current = structure[position];
      return (
        !current ||
        source.model !== current.model ||
        source.modelId !== current.modelId ||
        source.providerKey !== current.providerKey
      );
    })
  ) {
    index = buildProviderCostIndexBundle(structure, normalizeKey);
    cache.set(providers, index);
  }
  for (const entryKey of key === undefined ? index.sources.keys() : [key]) {
    refreshProviderCostIndexEntry(index, entryKey);
  }
  return index.entries;
}

function loadModelsJsonCostIndex(options?: {
  agentDir?: string;
  normalizeKey?: ModelKeyNormalizer;
}): Map<string, RawModelCostConfig> {
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
        entries: new WeakMap(),
      };
      pruneMapToMaxSize(modelsJsonCostCacheByAgentDir, MODELS_JSON_COST_CACHE_LIMIT - 1);
      modelsJsonCostCacheByAgentDir.set(agentDir, modelsJsonCostCache);
    }

    const normalizeKey = options?.normalizeKey ?? normalizeRawModelKey;
    let entries = modelsJsonCostCache.entries.get(normalizeKey);
    if (!entries) {
      entries = getProviderCostIndex(modelsJsonCostCache.providers, normalizeKey);
      modelsJsonCostCache.entries.set(normalizeKey, entries);
    }
    return entries;
  } catch {
    return EMPTY_PROVIDER_COST_INDEX;
  }
}

function resolveCostAgentDir(config?: OpenClawConfig, agentDir?: string): string | undefined {
  if (agentDir) {
    return agentDir;
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

function serializeCostIndex(
  entries: Map<string, RawModelCostConfig>,
): Array<[string, RawModelCostConfig]> {
  return Array.from(entries.entries()).toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * Fingerprints all model-pricing sources that can affect usage cost estimates.
 * Consumers cache this value to know when resolved cost entries need recomputation.
 */
export function resolveModelCostConfigFingerprint(
  config?: OpenClawConfig,
  agentDir?: string,
): string {
  const resolvedAgentDir = resolveCostAgentDir(config, agentDir);
  const sourceConfig = config ? projectConfigOntoRuntimeSourceSnapshot(config) : undefined;
  const pricingContext = resolveModelPricingContext(config);
  const serialized = stableCostFingerprintValue({
    configuredRaw: serializeCostIndex(getProviderCostIndex(sourceConfig?.models?.providers)),
    configuredNormalized: serializeCostIndex(
      getProviderCostIndex(sourceConfig?.models?.providers, pricingContext.normalizeKey),
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
    catalogPricing: modelCatalogPricingFingerprint(pricingContext),
  });
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Resolves local models.json first, then authored overrides over effective catalog prices.
 * Complete direct prices need no plugin normalization or provider discovery.
 */
export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
  agentDir?: string;
  allowPluginNormalization?: boolean;
}): ModelCostConfig | undefined {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    return undefined;
  }
  const rawKey = normalizeRawModelKey(provider, model);
  const agentDir = resolveCostAgentDir(params.config, params.agentDir);
  // Favor direct configured keys first so local pricing/status lookups stay
  // synchronous and do not drag plugin/provider discovery into the hot path.
  const rawModelsJsonCost = loadModelsJsonCostIndex({ agentDir }).get(rawKey);
  if (rawModelsJsonCost) {
    return normalizeModelCostConfig(rawModelsJsonCost);
  }

  // Materialized catalog defaults are not authored overrides. Preserve raw
  // partial fields and empty tiers until merging with the inherited schedule.
  const sourceConfig = params.config
    ? projectConfigOntoRuntimeSourceSnapshot(params.config)
    : undefined;
  let configuredCost = getProviderCostIndex(sourceConfig?.models?.providers, undefined, rawKey).get(
    rawKey,
  );
  let pricingContext: ReturnType<typeof resolveModelPricingContext> | undefined;
  if (params.allowPluginNormalization !== false && !configuredCost) {
    pricingContext = resolveModelPricingContext(params.config);
    const key = pricingContext.normalizeKey(provider, model);
    const modelsJsonCost = loadModelsJsonCostIndex({
      agentDir,
      normalizeKey: pricingContext.normalizeKey,
    }).get(key);
    if (modelsJsonCost) {
      return normalizeModelCostConfig(modelsJsonCost);
    }
    configuredCost = getProviderCostIndex(
      sourceConfig?.models?.providers,
      pricingContext.normalizeKey,
      key,
    ).get(key);
  }

  if (
    configuredCost &&
    configuredCost.input !== undefined &&
    configuredCost.output !== undefined &&
    configuredCost.cacheRead !== undefined &&
    configuredCost.cacheWrite !== undefined
  ) {
    return normalizeModelCostConfig(configuredCost);
  }
  // Display-only lookups reuse prepared prices without discovering plugins;
  // ordinary lookups inherit current catalog rates, never materialized defaults.
  if (params.allowPluginNormalization !== false) {
    pricingContext ??= resolveModelPricingContext(params.config);
  }
  const inheritedCost = pricingContext
    ? resolveModelPricing(pricingContext, pricingContext.normalizeKey(provider, model))
    : getProviderCostIndex(params.config?.models?.providers, undefined, rawKey).get(rawKey);
  const merged = mergeModelCost(
    inheritedCost ? normalizeResolvedPricing(inheritedCost) : undefined,
    configuredCost,
  );
  return merged ? normalizeResolvedPricing(merged) : undefined;
}

/** Estimates one call's USD cost; tier selection includes cached prompt tokens. */
export function estimateUsageCost(params: {
  usage?: NormalizedUsage | null;
  cost?: ModelCostConfig;
}): number | undefined {
  const usage = params.usage;
  const cost = params.cost;
  if (!usage || !cost) {
    return undefined;
  }
  const total = calculateUsageCost(usage, cost).total;
  return Number.isFinite(total) ? total : undefined;
}

/** Preserve summed per-call costs; aggregate tokens cannot reconstruct request tiers. */
export function estimateAggregateUsageCost(
  params: Parameters<typeof resolveModelCostConfig>[0] & {
    usage?: NormalizedUsage | null;
    cost?: ModelCostConfig;
  },
): number | undefined {
  const usage = params.usage;
  if (usage?.cost !== undefined) {
    return usage.cost.total;
  }
  const hasBillableBuckets =
    usage &&
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
      (value) => value !== undefined,
    );
  if (!hasBillableBuckets) {
    return undefined;
  }
  // Recorded totals own billing; discover fallback prices only for unpriced usage.
  const cost = params.cost ?? resolveModelCostConfig(params);
  return cost?.tieredPricing?.length ? undefined : estimateUsageCost({ usage, cost });
}

export function resetUsageFormatCachesForTest(): void {
  modelsJsonCostCacheByAgentDir = new Map();
  providerCostIndexByNormalizer = new WeakMap();
}
