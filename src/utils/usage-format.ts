import path from "node:path";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { modelKey, normalizeModelRef, normalizeProviderId } from "../agents/model-selection.js";
import type { NormalizedUsage } from "../agents/usage.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayModelPricingCacheFingerprint } from "../gateway/model-pricing-cache-state.js";
import { getCachedGatewayModelPricing } from "../gateway/model-pricing-cache.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

/**
 * A single tier in a tiered-pricing schedule.  Prices are expressed as
 * USD per-million tokens, just like the flat `ModelCostConfig` fields.
 *
 * `range` is a half-open interval `[start, end)` expressed in *input*
 * token counts.  The tiers MUST be sorted in ascending `range[0]` order
 * with no gaps.
 */
export type PricingTier = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** [startTokens, endTokens) — half-open interval on the input token axis. */
  range: [number, number];
};

type RawPricingTier = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  range: [number, number] | [number];
};

export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Optional tiered pricing tiers.  When present, `estimateUsageCost`
   *  uses them instead of the flat rates above.  The flat rates still
   *  serve as the "default / first-tier" fallback for callers that are
   *  unaware of tiered pricing. */
  tieredPricing?: PricingTier[];
};

export type UsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type ModelsJsonCostCache = {
  path: string;
  providers: Record<string, ModelProviderConfig> | undefined;
  normalizedEntries: Map<string, ModelCostConfig> | null;
  rawEntries: Map<string, ModelCostConfig> | null;
};

type ProviderCostIndexCacheEntry = {
  normalizedEntries?: ProviderCostIndex;
  rawEntries?: ProviderCostIndex;
};

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

type RawModelCostConfig = Omit<ModelCostConfig, "tieredPricing"> & {
  tieredPricing?: RawPricingTier[];
};

const EMPTY_PROVIDER_COST_INDEX = new Map<string, ModelCostConfig>();
const MODEL_KEY_CACHE_LIMIT = 4096;

let modelsJsonCostCache: ModelsJsonCostCache | null = null;
let providerCostIndexByConfig = new WeakMap<
  Record<string, ModelProviderConfig>,
  ProviderCostIndexCacheEntry
>();
let modelKeyCache = new Map<string, string | null>();
let sortedPricingTiersByInput = new WeakMap<PricingTier[], PricingTier[]>();

export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    const precision = safe >= 10_000 ? 0 : 1;
    const formattedThousands = (safe / 1_000).toFixed(precision);
    if (Number(formattedThousands) >= 1_000) {
      return `${(safe / 1_000_000).toFixed(1)}m`;
    }
    return `${formattedThousands}k`;
  }
  return String(Math.round(safe));
}

export function formatUsd(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

function toResolvedModelKey(params: {
  provider?: string;
  model?: string;
  allowPluginNormalization?: boolean;
}): string | null {
  const cacheKey = [
    "resolved",
    params.allowPluginNormalization === false ? "raw" : "default",
    params.provider ?? "",
    params.model ?? "",
  ].join("\0");
  if (modelKeyCache.has(cacheKey)) {
    return modelKeyCache.get(cacheKey) ?? null;
  }
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    cacheModelKey(cacheKey, null);
    return null;
  }
  const normalized = normalizeModelRef(provider, model, {
    allowManifestNormalization: params.allowPluginNormalization === false ? false : undefined,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  const key = modelKey(normalized.provider, normalized.model);
  cacheModelKey(cacheKey, key);
  return key;
}

function toDirectModelKey(params: { provider?: string; model?: string }): string | null {
  const cacheKey = ["direct", params.provider ?? "", params.model ?? ""].join("\0");
  if (modelKeyCache.has(cacheKey)) {
    return modelKeyCache.get(cacheKey) ?? null;
  }
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    cacheModelKey(cacheKey, null);
    return null;
  }
  const key = modelKey(provider, model);
  cacheModelKey(cacheKey, key);
  return key;
}

function cacheModelKey(cacheKey: string, key: string | null): void {
  if (modelKeyCache.size >= MODEL_KEY_CACHE_LIMIT) {
    modelKeyCache.clear();
  }
  modelKeyCache.set(cacheKey, key);
}

function shouldUseNormalizedCostLookup(params: { provider?: string; model?: string }): boolean {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model) ?? "";
  if (!provider || !model) {
    return false;
  }
  return provider === "anthropic" || provider === "openrouter" || provider === "vercel-ai-gateway";
}

/**
 * Normalize a raw tieredPricing array from models.json / config.
 * Supports open-ended ranges such as `[128000]` or `[128000, -1]`,
 * which are converted to `[128000, Infinity]`.
 */
function normalizeTieredPricing(raw: RawPricingTier[] | undefined): PricingTier[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const result: PricingTier[] = [];
  for (const tier of raw) {
    const range = tier.range;
    if (!Array.isArray(range) || range.length < 1) {
      continue;
    }
    const start = typeof range[0] === "number" ? range[0] : Number.NaN;
    if (!Number.isFinite(start)) {
      continue;
    }
    const rawEnd = range.length >= 2 ? range[1] : null;
    const end =
      typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : Infinity;
    if (
      !Number.isFinite(tier.input) ||
      !Number.isFinite(tier.output) ||
      !Number.isFinite(tier.cacheRead) ||
      !Number.isFinite(tier.cacheWrite)
    ) {
      continue;
    }
    result.push({
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
      range: [start, end],
    });
  }
  return result.length > 0 ? result.toSorted((a, b) => a.range[0] - b.range[0]) : undefined;
}

function normalizeModelCostConfig(cost: RawModelCostConfig): ModelCostConfig {
  const normalizedTiers = normalizeTieredPricing(cost.tieredPricing);
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    ...(normalizedTiers ? { tieredPricing: normalizedTiers } : {}),
  };
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
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
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
      const normalized = normalizeModelRef(normalizedProvider, model.id, {
        allowManifestNormalization:
          options?.allowManifestNormalization ??
          (options?.allowPluginNormalization === false ? false : undefined),
        allowPluginNormalization: options?.allowPluginNormalization,
      });
      const key = modelKey(normalized.provider, normalized.model);
      if (!isRawModelCostConfig(model.cost)) {
        continue;
      }
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

function buildProviderCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
): Map<string, ModelCostConfig> {
  return buildProviderCostIndexBundle(providers, options).entries;
}

function getProviderCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
): Map<string, ModelCostConfig> {
  if (!providers) {
    return EMPTY_PROVIDER_COST_INDEX;
  }
  const isRawLookup =
    options?.allowPluginNormalization === false &&
    (options.allowManifestNormalization === false ||
      options.allowManifestNormalization === undefined);
  const isDefaultNormalizedLookup =
    options?.allowPluginNormalization !== false &&
    options?.allowManifestNormalization === undefined;
  if (!isRawLookup && !isDefaultNormalizedLookup) {
    return buildProviderCostIndex(providers, options);
  }

  let cache = providerCostIndexByConfig.get(providers);
  if (!cache) {
    cache = {};
    providerCostIndexByConfig.set(providers, cache);
  }
  if (isRawLookup) {
    cache.rawEntries ??= buildProviderCostIndexBundle(providers, {
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    const rawOptions = {
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    };
    if (refreshProviderCostIndexMutations(cache.rawEntries, providers, rawOptions) === "rebuild") {
      cache.rawEntries = buildProviderCostIndexBundle(providers, rawOptions);
    }
    if (
      cache.rawEntries.structureFingerprint !== buildProviderCostStructureFingerprint(providers)
    ) {
      cache.rawEntries = buildProviderCostIndexBundle(providers, rawOptions);
    }
    return cache.rawEntries.entries;
  }
  cache.normalizedEntries ??= buildProviderCostIndexBundle(providers);
  if (refreshProviderCostIndexMutations(cache.normalizedEntries, providers) === "rebuild") {
    cache.normalizedEntries = buildProviderCostIndexBundle(providers);
  }
  if (
    cache.normalizedEntries.structureFingerprint !==
    buildProviderCostStructureFingerprint(providers)
  ) {
    cache.normalizedEntries = buildProviderCostIndexBundle(providers);
  }
  return cache.normalizedEntries.entries;
}

function loadModelsJsonCostIndex(options?: {
  allowPluginNormalization?: boolean;
}): Map<string, ModelCostConfig> {
  const useRawEntries = options?.allowPluginNormalization === false;
  const modelsPath = path.join(resolveDefaultAgentDir({}), "models.json");
  try {
    if (!modelsJsonCostCache || modelsJsonCostCache.path !== modelsPath) {
      const parsed = tryReadJsonSync<{
        providers?: Record<string, ModelProviderConfig>;
      }>(modelsPath);
      if (!parsed) {
        return EMPTY_PROVIDER_COST_INDEX;
      }
      modelsJsonCostCache = {
        path: modelsPath,
        providers: parsed?.providers,
        normalizedEntries: null,
        rawEntries: null,
      };
    }

    if (useRawEntries) {
      modelsJsonCostCache.rawEntries ??= getProviderCostIndex(modelsJsonCostCache.providers, {
        allowPluginNormalization: false,
      });
      return modelsJsonCostCache.rawEntries;
    }

    modelsJsonCostCache.normalizedEntries ??= getProviderCostIndex(modelsJsonCostCache.providers);
    return modelsJsonCostCache.normalizedEntries;
  } catch {
    return EMPTY_PROVIDER_COST_INDEX;
  }
}

function findConfiguredProviderCost(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
  allowPluginNormalization?: boolean;
}): ModelCostConfig | undefined {
  const key = toResolvedModelKey(params);
  if (!key) {
    return undefined;
  }
  return getProviderCostFromIndex(params.config?.models?.providers, key, {
    allowPluginNormalization: params.allowPluginNormalization,
  });
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
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
): boolean {
  const providerConfig = providers[source.providerKey];
  if (!providerConfig?.models?.includes(source.model)) {
    return false;
  }
  const normalized = normalizeModelRef(normalizeProviderId(source.providerKey), source.model.id, {
    allowManifestNormalization:
      options?.allowManifestNormalization ??
      (options?.allowPluginNormalization === false ? false : undefined),
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  return modelKey(normalized.provider, normalized.model) === key;
}

function refreshProviderCostIndexEntry(
  index: ProviderCostIndex,
  key: string,
  providers?: Record<string, ModelProviderConfig>,
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
): "current" | "rebuild" {
  const source = index.sources.get(key);
  if (!source) {
    return "current";
  }
  if (providers && !isProviderCostSourceCurrent(providers, source, key, options)) {
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
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
): "current" | "rebuild" {
  for (const key of index.sources.keys()) {
    if (refreshProviderCostIndexEntry(index, key, providers, options) === "rebuild") {
      return "rebuild";
    }
  }
  return "current";
}

function hasProviderCostSourceForKey(
  providers: Record<string, ModelProviderConfig>,
  key: string,
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
): boolean {
  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    const normalizedProvider = normalizeProviderId(providerKey);
    for (const model of providerConfig?.models ?? []) {
      if (!isRawModelCostConfig(model.cost)) {
        continue;
      }
      const normalized = normalizeModelRef(normalizedProvider, model.id, {
        allowManifestNormalization:
          options?.allowManifestNormalization ??
          (options?.allowPluginNormalization === false ? false : undefined),
        allowPluginNormalization: options?.allowPluginNormalization,
      });
      if (modelKey(normalized.provider, normalized.model) === key) {
        return true;
      }
    }
  }
  return false;
}

function getProviderCostFromIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  key: string,
  options?: { allowManifestNormalization?: boolean; allowPluginNormalization?: boolean },
): ModelCostConfig | undefined {
  if (!providers) {
    return undefined;
  }
  const isRawLookup =
    options?.allowPluginNormalization === false &&
    (options.allowManifestNormalization === false ||
      options.allowManifestNormalization === undefined);
  const isDefaultNormalizedLookup =
    options?.allowPluginNormalization !== false &&
    options?.allowManifestNormalization === undefined;
  if (!isRawLookup && !isDefaultNormalizedLookup) {
    return buildProviderCostIndex(providers, options).get(key);
  }

  let cache = providerCostIndexByConfig.get(providers);
  if (!cache) {
    cache = {};
    providerCostIndexByConfig.set(providers, cache);
  }
  const index = isRawLookup
    ? (cache.rawEntries ??= buildProviderCostIndexBundle(providers, {
        allowManifestNormalization: false,
        allowPluginNormalization: false,
      }))
    : (cache.normalizedEntries ??= buildProviderCostIndexBundle(providers));
  const sourceMissingWithStructuralChange =
    !index.sources.has(key) &&
    index.structureFingerprint !== buildProviderCostStructureFingerprint(providers);
  const sourceMissingWithNewCost =
    !index.sources.has(key) && hasProviderCostSourceForKey(providers, key, options);
  if (
    refreshProviderCostIndexEntry(index, key, providers, options) === "rebuild" ||
    sourceMissingWithStructuralChange ||
    sourceMissingWithNewCost
  ) {
    const rebuilt = buildProviderCostIndexBundle(
      providers,
      isRawLookup
        ? {
            allowManifestNormalization: false,
            allowPluginNormalization: false,
          }
        : undefined,
    );
    if (isRawLookup) {
      cache.rawEntries = rebuilt;
    } else {
      cache.normalizedEntries = rebuilt;
    }
    return rebuilt.entries.get(key);
  }
  return index.entries.get(key);
}

function serializeCostIndex(
  entries: Map<string, ModelCostConfig>,
): Array<[string, ModelCostConfig]> {
  return Array.from(entries.entries()).toSorted(([a], [b]) => a.localeCompare(b));
}

export function resolveModelCostConfigFingerprint(config?: OpenClawConfig): string {
  return stableCostFingerprintValue({
    configuredRaw: serializeCostIndex(
      getProviderCostIndex(config?.models?.providers, { allowPluginNormalization: false }),
    ),
    configuredNormalized: serializeCostIndex(getProviderCostIndex(config?.models?.providers)),
    modelsJsonRaw: serializeCostIndex(loadModelsJsonCostIndex({ allowPluginNormalization: false })),
    modelsJsonNormalized: serializeCostIndex(loadModelsJsonCostIndex()),
    gatewayPricing: getGatewayModelPricingCacheFingerprint(),
  });
}

export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
  allowPluginNormalization?: boolean;
}): ModelCostConfig | undefined {
  const rawKey = toDirectModelKey(params);
  if (!rawKey) {
    return undefined;
  }

  // Favor direct configured keys first so local pricing/status lookups stay
  // synchronous and do not drag plugin/provider discovery into the hot path.
  const rawModelsJsonCost = loadModelsJsonCostIndex({
    allowPluginNormalization: false,
  }).get(rawKey);
  if (rawModelsJsonCost) {
    return rawModelsJsonCost;
  }

  const rawConfiguredCost = findConfiguredProviderCost({
    ...params,
    allowPluginNormalization: false,
  });
  if (rawConfiguredCost) {
    return rawConfiguredCost;
  }

  if (params.allowPluginNormalization === false) {
    return undefined;
  }

  if (shouldUseNormalizedCostLookup(params)) {
    const key = toResolvedModelKey(params);
    if (key && key !== rawKey) {
      const modelsJsonCost = loadModelsJsonCostIndex().get(key);
      if (modelsJsonCost) {
        return modelsJsonCost;
      }

      const configuredCost = findConfiguredProviderCost(params);
      if (configuredCost) {
        return configuredCost;
      }
    }
  }

  return getCachedGatewayModelPricing(params);
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
    const tier = sortedTiers[index];
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
  modelsJsonCostCache = null;
  providerCostIndexByConfig = new WeakMap();
  modelKeyCache = new Map();
  sortedPricingTiersByInput = new WeakMap();
}
