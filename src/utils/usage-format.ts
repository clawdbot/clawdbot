import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { modelKey, normalizeModelRef, normalizeProviderId } from "../agents/model-selection.js";
import type { NormalizedUsage } from "../agents/usage.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCachedGatewayModelPricing } from "../gateway/model-pricing-cache.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
  mtimeMs: number;
  providers: Record<string, ModelProviderConfig> | undefined;
  normalizedEntries: Map<string, ModelCostConfig> | null;
  rawEntries: Map<string, ModelCostConfig> | null;
};

let modelsJsonCostCache: ModelsJsonCostCache | null = null;

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
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    return null;
  }
  const normalized = normalizeModelRef(provider, model, {
    allowPluginNormalization: params.allowPluginNormalization,
  });
  return modelKey(normalized.provider, normalized.model);
}

function toDirectModelKey(params: { provider?: string; model?: string }): string | null {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    return null;
  }
  return modelKey(provider, model);
}

function shouldUseNormalizedCostLookup(params: { provider?: string; model?: string }): boolean {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model) ?? "";
  if (!provider || !model) {
    return false;
  }
  return provider === "anthropic" || provider === "openrouter" || provider === "vercel-ai-gateway";
}

function buildProviderCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  options?: { allowPluginNormalization?: boolean },
): Map<string, ModelCostConfig> {
  const entries = new Map<string, ModelCostConfig>();
  if (!providers) {
    return entries;
  }
  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    const normalizedProvider = normalizeProviderId(providerKey);
    for (const model of providerConfig?.models ?? []) {
      const normalized = normalizeModelRef(normalizedProvider, model.id, {
        allowPluginNormalization: options?.allowPluginNormalization,
      });
      entries.set(modelKey(normalized.provider, normalized.model), model.cost);
    }
  }
  return entries;
}

function loadModelsJsonCostIndex(options?: {
  allowPluginNormalization?: boolean;
}): Map<string, ModelCostConfig> {
  const useRawEntries = options?.allowPluginNormalization === false;
  const modelsPath = path.join(resolveOpenClawAgentDir(), "models.json");
  try {
    const stat = fs.statSync(modelsPath);
    if (
      !modelsJsonCostCache ||
      modelsJsonCostCache.path !== modelsPath ||
      modelsJsonCostCache.mtimeMs !== stat.mtimeMs
    ) {
      const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as {
        providers?: Record<string, ModelProviderConfig>;
      };
      modelsJsonCostCache = {
        path: modelsPath,
        mtimeMs: stat.mtimeMs,
        providers: parsed.providers,
        normalizedEntries: null,
        rawEntries: null,
      };
    }

    if (useRawEntries) {
      modelsJsonCostCache.rawEntries ??= buildProviderCostIndex(modelsJsonCostCache.providers, {
        allowPluginNormalization: false,
      });
      return modelsJsonCostCache.rawEntries;
    }

    modelsJsonCostCache.normalizedEntries ??= buildProviderCostIndex(modelsJsonCostCache.providers);
    return modelsJsonCostCache.normalizedEntries;
  } catch {
    const empty = new Map<string, ModelCostConfig>();
    modelsJsonCostCache = {
      path: modelsPath,
      mtimeMs: -1,
      providers: undefined,
      normalizedEntries: empty,
      rawEntries: empty,
    };
    return empty;
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
  return buildProviderCostIndex(params.config?.models?.providers, {
    allowPluginNormalization: params.allowPluginNormalization,
  }).get(key);
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
  const total =
    input * cost.input +
    output * cost.output +
    cacheRead * cost.cacheRead +
    cacheWrite * cost.cacheWrite;
  if (!Number.isFinite(total)) {
    return undefined;
  }
  return total / 1_000_000;
}

export function __resetUsageFormatCachesForTest(): void {
  modelsJsonCostCache = null;
}
