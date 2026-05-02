import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  parseModelRef,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import { resolvePluginWebSearchConfig } from "../config/plugin-web-search-config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { planManifestModelCatalogRows, type ModelCatalogCost } from "../model-catalog/index.js";
import { isInstalledPluginEnabled } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type {
  PluginManifestModelPricingModelIdTransform,
  PluginManifestModelPricingProvider,
  PluginManifestModelPricingSource,
} from "../plugins/manifest.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataRegistryView } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistrySnapshot } from "../plugins/plugin-registry.js";
import { normalizeOptionalString, resolvePrimaryStringValue } from "../shared/string-coerce.js";
import {
  clearGatewayModelPricingCacheState,
  getCachedGatewayModelPricing,
  getGatewayModelPricingCacheMeta as getGatewayModelPricingCacheMetaState,
  replaceGatewayModelPricingCache,
  type CachedModelPricing,
  type CachedPricingTier,
} from "./model-pricing-cache-state.js";
import { isGatewayModelPricingEnabled } from "./model-pricing-config.js";

type OpenRouterPricingEntry = {
  id: string;
  pricing: CachedModelPricing;
};

type ModelListLike = string | { primary?: string; fallbacks?: string[] } | undefined;

type ModelPricingManifestMetadata = {
  allRegistry: PluginManifestRegistry;
  activeRegistry: PluginManifestRegistry;
};

type OpenRouterModelPayload = {
  id?: unknown;
  pricing?: unknown;
};

type GatewayModelPricingRefreshParams = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  workspaceDir?: string;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
  pluginLookUpTable?: PluginMetadataRegistryView;
  manifestRegistry?: PluginManifestRegistry;
  signal?: AbortSignal;
};

type ExternalPricingPolicy = {
  external: boolean;
  openRouter?: ExternalPricingSourcePolicy;
  liteLLM?: ExternalPricingSourcePolicy;
};

type ExternalPricingSourcePolicy = {
  provider?: string;
  passthroughProviderModel?: boolean;
  modelIdTransforms: readonly PluginManifestModelPricingModelIdTransform[];
};

export { getCachedGatewayModelPricing };

type PricingModelNormalizationOptions = {
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
};

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_PRICING_CATALOG_BYTES = 5 * 1024 * 1024;
const log = createSubsystemLogger("gateway").child("model-pricing");

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightRefresh: Promise<void> | null = null;

function clearRefreshTimer(): void {
  if (!refreshTimer) {
    return;
  }
  clearTimeout(refreshTimer);
  refreshTimer = null;
}

function getPricingModelNormalizationOptions(
  config: OpenClawConfig,
): PricingModelNormalizationOptions {
  const allowPluginBackedNormalization = config.plugins?.enabled !== false;
  return {
    allowManifestNormalization: allowPluginBackedNormalization,
    allowPluginNormalization: allowPluginBackedNormalization,
  };
}

function listLikeFallbacks(value: ModelListLike): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  return Array.isArray(value.fallbacks)
    ? value.fallbacks
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];
}

function parseNumberString(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimeoutSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function readErrorName(error: unknown): string | undefined {
  return error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (readErrorName(error) === "TimeoutError") {
    return true;
  }
  return /\bTimeoutError\b/u.test(String(error));
}

function createPricingFetchSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function formatPricingFetchFailure(source: "LiteLLM" | "OpenRouter", error: unknown): string {
  if (isTimeoutError(error)) {
    return `${source} pricing fetch failed (timeout ${formatTimeoutSeconds(FETCH_TIMEOUT_MS)}): ${String(error)}`;
  }
  return `${source} pricing fetch failed: ${String(error)}`;
}

function toPricePerMillion(value: number | null): number {
  if (value === null || value < 0 || !Number.isFinite(value)) {
    return 0;
  }
  const scaled = value * 1_000_000;
  return Number.isFinite(scaled) ? scaled : 0;
}

function parseOpenRouterPricing(value: unknown): CachedModelPricing | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const pricing = value as Record<string, unknown>;
  const prompt = parseNumberString(pricing.prompt);
  const completion = parseNumberString(pricing.completion);
  if (prompt === null || completion === null) {
    return null;
  }
  return {
    input: toPricePerMillion(prompt),
    output: toPricePerMillion(completion),
    cacheRead: toPricePerMillion(parseNumberString(pricing.input_cache_read)),
    cacheWrite: toPricePerMillion(parseNumberString(pricing.input_cache_write)),
  };
}

function toCachedPricingTier(value: unknown): CachedPricingTier | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const tier = value as Record<string, unknown>;
  const input = parseNumberString(tier.input);
  const output = parseNumberString(tier.output);
  const range = tier.range;
  if (input === null || output === null || !Array.isArray(range) || range.length < 1) {
    return null;
  }
  const start = parseNumberString(range[0]);
  if (start === null) {
    return null;
  }
  const rawEnd = range.length >= 2 ? parseNumberString(range[1]) : null;
  const end = rawEnd === null || rawEnd <= start ? Infinity : rawEnd;
  return {
    input,
    output,
    cacheRead: parseNumberString(tier.cacheRead) ?? 0,
    cacheWrite: parseNumberString(tier.cacheWrite) ?? 0,
    range: [start, end],
  };
}

function toCachedModelPricing(
  value: ModelCatalogCost | ModelDefinitionConfig["cost"] | undefined,
): CachedModelPricing | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const input = parseNumberString(value.input) ?? 0;
  const output = parseNumberString(value.output) ?? 0;
  const cacheRead = parseNumberString(value.cacheRead) ?? 0;
  const cacheWrite = parseNumberString(value.cacheWrite) ?? 0;
  const tieredPricing = Array.isArray(value.tieredPricing)
    ? value.tieredPricing
        .map((tier) => toCachedPricingTier(tier))
        .filter((tier): tier is CachedPricingTier => Boolean(tier))
        .toSorted((left, right) => left.range[0] - right.range[0])
    : [];
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(tieredPricing.length > 0 ? { tieredPricing } : {}),
  };
}

async function readPricingJsonObject(
  response: Response,
  source: string,
): Promise<Record<string, unknown>> {
  const contentLength = parseNumberString(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_PRICING_CATALOG_BYTES) {
    throw new Error(`${source} pricing response too large: ${contentLength} bytes`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PRICING_CATALOG_BYTES) {
    throw new Error(`${source} pricing response too large: ${buffer.byteLength} bytes`);
  }
  const payload = JSON.parse(Buffer.from(buffer).toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${source} pricing response is not a JSON object`);
  }
  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LiteLLM tiered-pricing parsing
// ---------------------------------------------------------------------------

type LiteLLMModelEntry = Record<string, unknown>;

type LiteLLMTierRaw = {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
  range?: unknown;
};

function parseLiteLLMTieredPricing(tiers: unknown): CachedPricingTier[] | undefined {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return undefined;
  }
  const result: CachedPricingTier[] = [];
  for (const raw of tiers) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const tier = raw as LiteLLMTierRaw;
    const inputPerToken = parseNumberString(tier.input_cost_per_token);
    const outputPerToken = parseNumberString(tier.output_cost_per_token);
    if (inputPerToken === null || outputPerToken === null) {
      continue;
    }
    const range = tier.range;
    if (!Array.isArray(range) || range.length < 1) {
      continue;
    }
    const start = parseNumberString(range[0]);
    if (start === null) {
      continue;
    }
    // Allow open-ended ranges: [128000], [128000, -1], [128000, null]
    const rawEnd = range.length >= 2 ? parseNumberString(range[1]) : null;
    const end = rawEnd === null || rawEnd <= start ? Infinity : rawEnd;
    if (
      !Number.isFinite(inputPerToken) ||
      !Number.isFinite(outputPerToken) ||
      inputPerToken < 0 ||
      outputPerToken < 0
    ) {
      continue;
    }
    result.push({
      input: toPricePerMillion(inputPerToken),
      output: toPricePerMillion(outputPerToken),
      cacheRead: toPricePerMillion(parseNumberString(tier.cache_read_input_token_cost)),
      cacheWrite: toPricePerMillion(parseNumberString(tier.cache_creation_input_token_cost)),
      range: [start, end],
    });
  }
  return result.length > 0 ? result.toSorted((a, b) => a.range[0] - b.range[0]) : undefined;
}

function parseLiteLLMPricing(entry: LiteLLMModelEntry): CachedModelPricing | null {
  const inputPerToken = parseNumberString(entry.input_cost_per_token);
  const outputPerToken = parseNumberString(entry.output_cost_per_token);
  if (inputPerToken === null || outputPerToken === null) {
    return null;
  }
  const pricing: CachedModelPricing = {
    input: toPricePerMillion(inputPerToken),
    output: toPricePerMillion(outputPerToken),
    cacheRead: toPricePerMillion(parseNumberString(entry.cache_read_input_token_cost)),
    cacheWrite: toPricePerMillion(parseNumberString(entry.cache_creation_input_token_cost)),
  };
  const tieredPricing = parseLiteLLMTieredPricing(entry.tiered_pricing);
  if (tieredPricing) {
    pricing.tieredPricing = tieredPricing;
  }
  return pricing;
}

type LiteLLMPricingCatalog = Map<string, CachedModelPricing>;

async function fetchLiteLLMPricingCatalog(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<LiteLLMPricingCatalog> {
  const response = await fetchImpl(LITELLM_PRICING_URL, {
    headers: { Accept: "application/json" },
    signal: createPricingFetchSignal(signal),
  });
  if (!response.ok) {
    throw new Error(`LiteLLM pricing fetch failed: HTTP ${response.status}`);
  }
  const payload = await readPricingJsonObject(response, "LiteLLM");
  const catalog: LiteLLMPricingCatalog = new Map();
  for (const [key, value] of Object.entries(payload)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const entry = value as LiteLLMModelEntry;
    const pricing = parseLiteLLMPricing(entry);
    if (!pricing) {
      continue;
    }
    catalog.set(key, pricing);
  }
  return catalog;
}

function normalizeExternalPricingSource(
  value: PluginManifestModelPricingSource | false | undefined,
): ExternalPricingSourcePolicy | undefined {
  if (!value) {
    return undefined;
  }
  return {
    ...(value.provider
      ? { provider: normalizeModelRef(value.provider, "placeholder").provider }
      : {}),
    ...(value.passthroughProviderModel ? { passthroughProviderModel: true } : {}),
    modelIdTransforms: value.modelIdTransforms ?? [],
  };
}

function normalizeExternalPricingPolicy(
  value: PluginManifestModelPricingProvider | undefined,
): ExternalPricingPolicy | undefined {
  if (!value) {
    return undefined;
  }
  return {
    external: value.external !== false,
    ...(normalizeExternalPricingSource(value.openRouter) !== undefined
      ? { openRouter: normalizeExternalPricingSource(value.openRouter) }
      : {}),
    ...(normalizeExternalPricingSource(value.liteLLM) !== undefined
      ? { liteLLM: normalizeExternalPricingSource(value.liteLLM) }
      : {}),
  };
}

function filterActiveManifestRegistry(params: {
  registry: PluginManifestRegistry;
  index: PluginRegistrySnapshot;
  config: OpenClawConfig;
}): PluginManifestRegistry {
  return {
    diagnostics: params.registry.diagnostics,
    plugins: params.registry.plugins.filter((plugin) =>
      isInstalledPluginEnabled(params.index, plugin.id, params.config),
    ),
  };
}

function resolveModelPricingManifestMetadata(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
  pluginLookUpTable?: PluginMetadataRegistryView;
  manifestRegistry?: PluginManifestRegistry;
}): ModelPricingManifestMetadata {
  const metadataSnapshot = params.pluginMetadataSnapshot ?? params.pluginLookUpTable;
  if (metadataSnapshot) {
    return {
      allRegistry: metadataSnapshot.manifestRegistry,
      activeRegistry: filterActiveManifestRegistry({
        registry: metadataSnapshot.manifestRegistry,
        index: metadataSnapshot.index,
        config: params.config,
      }),
    };
  }
  if (params.manifestRegistry) {
    return {
      allRegistry: params.manifestRegistry,
      activeRegistry: params.manifestRegistry,
    };
  }
  if (params.config.plugins?.enabled === false) {
    const emptyRegistry: PluginManifestRegistry = { plugins: [], diagnostics: [] };
    return {
      allRegistry: emptyRegistry,
      activeRegistry: emptyRegistry,
    };
  }
  const snapshot = loadPluginMetadataSnapshot({
    config: params.config,
    env: params.env ?? process.env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  return {
    allRegistry: snapshot.manifestRegistry,
    activeRegistry: filterActiveManifestRegistry({
      registry: snapshot.manifestRegistry,
      index: snapshot.index,
      config: params.config,
    }),
  };
}

function loadManifestPricingContext(registry: PluginManifestRegistry): {
  policies: Map<string, ExternalPricingPolicy>;
  catalogPricing: Map<string, CachedModelPricing>;
} {
  const policies = new Map<string, ExternalPricingPolicy>();
  for (const plugin of registry.plugins) {
    for (const [provider, rawPolicy] of Object.entries(plugin.modelPricing?.providers ?? {})) {
      const policy = normalizeExternalPricingPolicy(rawPolicy);
      if (policy) {
        policies.set(provider, policy);
      }
    }
  }

  const catalogPricing = new Map<string, CachedModelPricing>();
  for (const row of planManifestModelCatalogRows({ registry }).rows) {
    const pricing = toCachedModelPricing(row.cost);
    if (pricing) {
      catalogPricing.set(modelKey(row.provider, row.id), pricing);
    }
  }

  return { policies, catalogPricing };
}

function applyModelIdTransform(
  model: string,
  transform: PluginManifestModelPricingModelIdTransform,
): string {
  switch (transform) {
    case "version-dots":
      return model
        .replace(/^claude-(\d+)-(\d+)-/u, "claude-$1.$2-")
        .replace(/^claude-([a-z]+)-(\d+)-(\d+)$/u, "claude-$1-$2.$3");
  }
  return model;
}

function applyModelIdTransforms(
  model: string,
  transforms: readonly PluginManifestModelPricingModelIdTransform[],
): string[] {
  const variants = new Set([model]);
  for (const transform of transforms) {
    const snapshot = Array.from(variants);
    for (const variant of snapshot) {
      variants.add(applyModelIdTransform(variant, transform));
    }
  }
  return [...variants];
}

function canonicalizeOpenRouterLookupId(
  id: string,
  options: PricingModelNormalizationOptions = {
    allowManifestNormalization: true,
    allowPluginNormalization: true,
  },
): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return "";
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return trimmed;
  }
  const provider = normalizeModelRef(trimmed.slice(0, slash), "placeholder", {
    allowManifestNormalization: options.allowManifestNormalization,
    allowPluginNormalization: options.allowPluginNormalization,
  }).provider;
  const model = trimmed.slice(slash + 1).trim();
  if (!model) {
    return provider;
  }
  const normalizedModel = normalizeModelRef(provider, model, {
    allowManifestNormalization: options.allowManifestNormalization,
    allowPluginNormalization: options.allowPluginNormalization,
  }).model;
  return modelKey(provider, normalizedModel);
}

function buildExternalCatalogCandidates(params: {
  ref: ModelRef;
  source: "openRouter" | "liteLLM";
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  seen?: Set<string>;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
}): string[] {
  const { ref, source, policies } = params;
  const refKey = modelKey(ref.provider, ref.model);
  const seen = params.seen ?? new Set<string>();
  if (seen.has(refKey)) {
    return [];
  }
  const nextSeen = new Set(seen);
  nextSeen.add(refKey);

  const policy = policies.get(ref.provider);
  if (policy?.external === false) {
    return [];
  }
  const sourcePolicy = policy?.[source];
  if (sourcePolicy === undefined && policy && source === "openRouter") {
    return [];
  }
  if (sourcePolicy === undefined && policy && source === "liteLLM") {
    return [];
  }
  const provider = sourcePolicy?.provider ?? ref.provider;
  const transforms = sourcePolicy?.modelIdTransforms ?? [];
  const candidates = new Set<string>();

  for (const model of applyModelIdTransforms(ref.model, transforms)) {
    const candidate = modelKey(provider, model);
    candidates.add(
      source === "openRouter"
        ? canonicalizeOpenRouterLookupId(candidate, {
            allowManifestNormalization: params.allowManifestNormalization ?? true,
            allowPluginNormalization: params.allowPluginNormalization ?? true,
          })
        : candidate,
    );
  }

  if (sourcePolicy?.passthroughProviderModel && ref.model.includes("/")) {
    const nestedRef = parseModelRef(ref.model, DEFAULT_PROVIDER, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (nestedRef) {
      for (const candidate of buildExternalCatalogCandidates({
        ref: nestedRef,
        source,
        policies,
        seen: nextSeen,
        allowManifestNormalization: params.allowManifestNormalization,
        allowPluginNormalization: params.allowPluginNormalization,
      })) {
        candidates.add(candidate);
      }
    }
  }

  return Array.from(candidates).filter(Boolean);
}

function addResolvedModelRef(params: {
  raw: string | undefined;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  refs: Map<string, ModelRef>;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): void {
  const raw = params.raw?.trim();
  if (!raw) {
    return;
  }
  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex: params.aliasIndex,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  if (!resolved) {
    return;
  }
  const normalized = normalizeModelRef(resolved.ref.provider, resolved.ref.model, {
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  params.refs.set(modelKey(normalized.provider, normalized.model), normalized);
}

function addModelListLike(params: {
  value: ModelListLike;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  refs: Map<string, ModelRef>;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): void {
  addResolvedModelRef({
    raw: resolvePrimaryStringValue(params.value),
    aliasIndex: params.aliasIndex,
    refs: params.refs,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  for (const fallback of listLikeFallbacks(params.value)) {
    addResolvedModelRef({
      raw: fallback,
      aliasIndex: params.aliasIndex,
      refs: params.refs,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
  }
}

function addProviderModelPair(params: {
  provider: string | undefined;
  model: string | undefined;
  refs: Map<string, ModelRef>;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): void {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return;
  }
  const normalized = normalizeModelRef(provider, model, {
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  params.refs.set(modelKey(normalized.provider, normalized.model), normalized);
}

function addConfiguredWebSearchPluginModels(params: {
  config: OpenClawConfig;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  refs: Map<string, ModelRef>;
  manifestRegistry: PluginManifestRegistry;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): void {
  for (const pluginId of params.manifestRegistry.plugins
    .filter((plugin) => (plugin.contracts?.webSearchProviders ?? []).length > 0)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right))) {
    addResolvedModelRef({
      raw: resolvePluginWebSearchConfig(params.config, pluginId)?.model as string | undefined,
      aliasIndex: params.aliasIndex,
      refs: params.refs,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
  }
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fe80:")) {
    return true;
  }
  if (host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[0-1])\./u.test(host) || host.startsWith("169.254.");
}

function isPrivateOrLoopbackBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    return isPrivateOrLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function findConfiguredProviderModel(
  config: OpenClawConfig,
  ref: ModelRef,
  options: PricingModelNormalizationOptions = {
    allowManifestNormalization: true,
    allowPluginNormalization: true,
  },
): ModelDefinitionConfig | undefined {
  const providerConfig = config.models?.providers?.[ref.provider];
  return providerConfig?.models?.find((model) => {
    const normalized = normalizeModelRef(ref.provider, model.id, {
      allowManifestNormalization: options.allowManifestNormalization,
      allowPluginNormalization: options.allowPluginNormalization,
    });
    return modelKey(normalized.provider, normalized.model) === modelKey(ref.provider, ref.model);
  });
}

function getConfiguredModelPricing(
  config: OpenClawConfig,
  ref: ModelRef,
  options: PricingModelNormalizationOptions = {
    allowManifestNormalization: true,
    allowPluginNormalization: true,
  },
): CachedModelPricing | undefined {
  return toCachedModelPricing(findConfiguredProviderModel(config, ref, options)?.cost);
}

function hasPrivateOrLoopbackConfiguredEndpoint(
  config: OpenClawConfig,
  ref: ModelRef,
  options: PricingModelNormalizationOptions = {
    allowManifestNormalization: true,
    allowPluginNormalization: true,
  },
): boolean {
  const providerConfig = config.models?.providers?.[ref.provider];
  const model = findConfiguredProviderModel(config, ref, options);
  return (
    isPrivateOrLoopbackBaseUrl(model?.baseUrl) ||
    isPrivateOrLoopbackBaseUrl(providerConfig?.baseUrl)
  );
}

function shouldFetchExternalPricingForRef(params: {
  config: OpenClawConfig;
  ref: ModelRef;
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  seededPricing: ReadonlyMap<string, CachedModelPricing>;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): boolean {
  if (params.seededPricing.has(modelKey(params.ref.provider, params.ref.model))) {
    return false;
  }
  if (
    hasPrivateOrLoopbackConfiguredEndpoint(params.config, params.ref, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    })
  ) {
    return false;
  }
  if (params.policies.get(params.ref.provider)?.external === false) {
    return false;
  }
  return true;
}

function filterExternalPricingRefs(params: {
  config: OpenClawConfig;
  refs: ModelRef[];
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  seededPricing: ReadonlyMap<string, CachedModelPricing>;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): ModelRef[] {
  return params.refs.filter((ref) =>
    shouldFetchExternalPricingForRef({
      config: params.config,
      ref,
      policies: params.policies,
      seededPricing: params.seededPricing,
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    }),
  );
}

export function collectConfiguredModelPricingRefs(
  config: OpenClawConfig,
  options: { manifestRegistry?: PluginManifestRegistry } = {},
): ModelRef[] {
  const manifestRegistry =
    options.manifestRegistry ?? resolveModelPricingManifestMetadata({ config }).allRegistry;
  const normalizationOptions = getPricingModelNormalizationOptions(config);
  const refs = new Map<string, ModelRef>();
  const aliasIndex = buildModelAliasIndex({
    cfg: config,
    defaultProvider: DEFAULT_PROVIDER,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });

  addModelListLike({
    value: config.agents?.defaults?.model,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });
  addModelListLike({
    value: config.agents?.defaults?.imageModel,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });
  addModelListLike({
    value: config.agents?.defaults?.pdfModel,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });
  addResolvedModelRef({
    raw: config.agents?.defaults?.compaction?.model,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });
  addResolvedModelRef({
    raw: config.agents?.defaults?.heartbeat?.model,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });
  addModelListLike({
    value: config.tools?.subagents?.model,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });
  addResolvedModelRef({
    raw: config.messages?.tts?.summaryModel,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });
  addResolvedModelRef({
    raw: config.hooks?.gmail?.model,
    aliasIndex,
    refs,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });

  for (const agent of config.agents?.list ?? []) {
    addModelListLike({
      value: agent.model,
      aliasIndex,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
    addModelListLike({
      value: agent.subagents?.model,
      aliasIndex,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
    addResolvedModelRef({
      raw: agent.heartbeat?.model,
      aliasIndex,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
  }

  for (const mapping of config.hooks?.mappings ?? []) {
    addResolvedModelRef({
      raw: mapping.model,
      aliasIndex,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
  }

  for (const channelMap of Object.values(config.channels?.modelByChannel ?? {})) {
    if (!channelMap || typeof channelMap !== "object") {
      continue;
    }
    for (const raw of Object.values(channelMap)) {
      addResolvedModelRef({
        raw: typeof raw === "string" ? raw : undefined,
        aliasIndex,
        refs,
        allowManifestNormalization: normalizationOptions.allowManifestNormalization,
        allowPluginNormalization: normalizationOptions.allowPluginNormalization,
      });
    }
  }

  addConfiguredWebSearchPluginModels({
    config,
    aliasIndex,
    refs,
    manifestRegistry,
    allowManifestNormalization: normalizationOptions.allowManifestNormalization,
    allowPluginNormalization: normalizationOptions.allowPluginNormalization,
  });

  for (const entry of config.tools?.media?.models ?? []) {
    addProviderModelPair({
      provider: entry.provider,
      model: entry.model,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
  }
  for (const entry of config.tools?.media?.image?.models ?? []) {
    addProviderModelPair({
      provider: entry.provider,
      model: entry.model,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
  }
  for (const entry of config.tools?.media?.audio?.models ?? []) {
    addProviderModelPair({
      provider: entry.provider,
      model: entry.model,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
  }
  for (const entry of config.tools?.media?.video?.models ?? []) {
    addProviderModelPair({
      provider: entry.provider,
      model: entry.model,
      refs,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
  }

  return Array.from(refs.values());
}

async function fetchOpenRouterPricingCatalog(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Map<string, OpenRouterPricingEntry>> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { Accept: "application/json" },
    signal: createPricingFetchSignal(signal),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models failed: HTTP ${response.status}`);
  }
  const payload = await readPricingJsonObject(response, "OpenRouter");
  const entries = Array.isArray(payload.data) ? payload.data : [];
  const catalog = new Map<string, OpenRouterPricingEntry>();
  for (const entry of entries) {
    const obj = entry as OpenRouterModelPayload;
    const id = normalizeOptionalString(obj.id) ?? "";
    const pricing = parseOpenRouterPricing(obj.pricing);
    if (!id || !pricing) {
      continue;
    }
    catalog.set(id, { id, pricing });
  }
  return catalog;
}

function resolveCatalogPricingForRef(params: {
  ref: ModelRef;
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  catalogById: Map<string, OpenRouterPricingEntry>;
  catalogByNormalizedId: Map<string, OpenRouterPricingEntry>;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): CachedModelPricing | undefined {
  const candidates = buildExternalCatalogCandidates({
    ref: params.ref,
    source: "openRouter",
    policies: params.policies,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  for (const candidate of candidates) {
    const exact = params.catalogById.get(candidate);
    if (exact) {
      return exact.pricing;
    }
  }
  for (const candidate of candidates) {
    const normalized = canonicalizeOpenRouterLookupId(candidate, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (!normalized) {
      continue;
    }
    const match = params.catalogByNormalizedId.get(normalized);
    if (match) {
      return match.pricing;
    }
  }
  return undefined;
}

function resolveLiteLLMPricingForRef(params: {
  ref: ModelRef;
  policies: ReadonlyMap<string, ExternalPricingPolicy>;
  catalog: LiteLLMPricingCatalog;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): CachedModelPricing | undefined {
  for (const candidate of buildExternalCatalogCandidates({
    ref: params.ref,
    source: "liteLLM",
    policies: params.policies,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
  })) {
    const pricing = params.catalog.get(candidate);
    if (pricing) {
      return pricing;
    }
  }
  return undefined;
}

function scheduleRefresh(
  params: GatewayModelPricingRefreshParams & { fetchImpl: typeof fetch },
): void {
  clearRefreshTimer();
  if (params.signal?.aborted) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (params.signal?.aborted) {
      return;
    }
    void refreshGatewayModelPricingCache(params).catch((error: unknown) => {
      log.warn(`pricing refresh failed: ${String(error)}`);
    });
  }, CACHE_TTL_MS);
  refreshTimer.unref?.();
}

function collectSeededPricing(params: {
  config: OpenClawConfig;
  refs: readonly ModelRef[];
  catalogPricing: ReadonlyMap<string, CachedModelPricing>;
  allowManifestNormalization: boolean;
  allowPluginNormalization: boolean;
}): Map<string, CachedModelPricing> {
  const seeded = new Map<string, CachedModelPricing>();
  for (const ref of params.refs) {
    const key = modelKey(ref.provider, ref.model);
    const configuredPricing = getConfiguredModelPricing(params.config, ref, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    if (configuredPricing) {
      seeded.set(key, configuredPricing);
      continue;
    }
    const catalogPricing = params.catalogPricing.get(key);
    if (catalogPricing) {
      seeded.set(key, catalogPricing);
    }
  }
  return seeded;
}

export async function refreshGatewayModelPricingCache(
  params: GatewayModelPricingRefreshParams,
): Promise<void> {
  if (!isGatewayModelPricingEnabled(params.config)) {
    clearRefreshTimer();
    return;
  }
  if (params.signal?.aborted) {
    return;
  }
  if (inFlightRefresh) {
    return await inFlightRefresh;
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  inFlightRefresh = (async () => {
    const manifestMetadata = resolveModelPricingManifestMetadata({
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      pluginLookUpTable: params.pluginLookUpTable,
      manifestRegistry: params.manifestRegistry,
    });
    const normalizationOptions = getPricingModelNormalizationOptions(params.config);
    const pricingContext = loadManifestPricingContext(manifestMetadata.activeRegistry);
    const allRefs = collectConfiguredModelPricingRefs(params.config, {
      manifestRegistry: manifestMetadata.allRegistry,
    });
    const seededPricing = collectSeededPricing({
      config: params.config,
      refs: allRefs,
      catalogPricing: pricingContext.catalogPricing,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
    const refs = filterExternalPricingRefs({
      config: params.config,
      refs: allRefs,
      policies: pricingContext.policies,
      seededPricing,
      allowManifestNormalization: normalizationOptions.allowManifestNormalization,
      allowPluginNormalization: normalizationOptions.allowPluginNormalization,
    });
    if (refs.length === 0) {
      if (params.signal?.aborted) {
        return;
      }
      replaceGatewayModelPricingCache(seededPricing);
      clearRefreshTimer();
      return;
    }

    // Fetch both pricing catalogs in parallel.  Each source is
    // independently optional — a failure in one does not block the other.
    let openRouterFailed = false;
    let litellmFailed = false;
    const [catalogById, litellmCatalog] = await Promise.all([
      fetchOpenRouterPricingCatalog(fetchImpl, params.signal).catch((error: unknown) => {
        log.warn(formatPricingFetchFailure("OpenRouter", error));
        openRouterFailed = true;
        return new Map<string, OpenRouterPricingEntry>();
      }),
      fetchLiteLLMPricingCatalog(fetchImpl, params.signal).catch((error: unknown) => {
        log.warn(formatPricingFetchFailure("LiteLLM", error));
        litellmFailed = true;
        return new Map<string, CachedModelPricing>() as LiteLLMPricingCatalog;
      }),
    ]);

    if (params.signal?.aborted) {
      return;
    }

    const catalogByNormalizedId = new Map<string, OpenRouterPricingEntry>();
    for (const entry of catalogById.values()) {
      const normalizedId = canonicalizeOpenRouterLookupId(entry.id, normalizationOptions);
      if (!normalizedId || catalogByNormalizedId.has(normalizedId)) {
        continue;
      }
      catalogByNormalizedId.set(normalizedId, entry);
    }

    const nextPricing = new Map<string, CachedModelPricing>(seededPricing);
    for (const ref of refs) {
      // 1. Try OpenRouter first (existing behavior — flat pricing)
      const openRouterPricing = resolveCatalogPricingForRef({
        ref,
        policies: pricingContext.policies,
        catalogById,
        catalogByNormalizedId,
        allowManifestNormalization: normalizationOptions.allowManifestNormalization,
        allowPluginNormalization: normalizationOptions.allowPluginNormalization,
      });

      // 2. Try LiteLLM (may contain tiered pricing)
      const litellmPricing = resolveLiteLLMPricingForRef({
        ref,
        policies: pricingContext.policies,
        catalog: litellmCatalog,
        allowManifestNormalization: normalizationOptions.allowManifestNormalization,
        allowPluginNormalization: normalizationOptions.allowPluginNormalization,
      });

      // Merge strategy: OpenRouter provides the base flat pricing;
      // LiteLLM enriches with tieredPricing when available.
      // If only one source has data, use that one.
      if (openRouterPricing && litellmPricing?.tieredPricing) {
        // Both sources present and LiteLLM has tiers — merge.
        nextPricing.set(modelKey(ref.provider, ref.model), {
          ...openRouterPricing,
          tieredPricing: litellmPricing.tieredPricing,
        });
      } else if (openRouterPricing) {
        // Prefer OpenRouter flat pricing when LiteLLM has no tiers to contribute.
        nextPricing.set(modelKey(ref.provider, ref.model), openRouterPricing);
      } else if (litellmPricing) {
        // Only LiteLLM has data — use it as-is.
        nextPricing.set(modelKey(ref.provider, ref.model), litellmPricing);
      }
    }

    // When either upstream source failed, preserve previously-cached entries
    // for any models that the refresh could not resolve.  This prevents a
    // single-source outage from silently dropping pricing for models that
    // depended on the failed source.
    if (openRouterFailed || litellmFailed) {
      const existingMeta = getGatewayModelPricingCacheMetaState();
      if (nextPricing.size === 0 && existingMeta.size > 0) {
        // Both sources failed — retain the entire existing cache.
        log.warn("Both pricing sources returned empty data — retaining existing cache");
        scheduleRefresh({ ...params, fetchImpl });
        return;
      }
      // Partial failure — back-fill missing models from the existing cache.
      for (const ref of refs) {
        const key = modelKey(ref.provider, ref.model);
        if (!nextPricing.has(key)) {
          const existing = getCachedGatewayModelPricing({
            provider: ref.provider,
            model: ref.model,
          });
          if (existing) {
            nextPricing.set(key, existing);
          }
        }
      }
    }

    if (params.signal?.aborted) {
      return;
    }
    replaceGatewayModelPricingCache(nextPricing);
    scheduleRefresh({ ...params, fetchImpl });
  })();

  try {
    await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

export function startGatewayModelPricingRefresh(
  params: GatewayModelPricingRefreshParams,
): () => void {
  if (!isGatewayModelPricingEnabled(params.config)) {
    clearRefreshTimer();
    return () => {};
  }
  let stopped = false;
  const abortController = new AbortController();
  queueMicrotask(() => {
    if (stopped) {
      return;
    }
    void refreshGatewayModelPricingCache({ ...params, signal: abortController.signal }).catch(
      (error: unknown) => {
        log.warn(`pricing bootstrap failed: ${String(error)}`);
      },
    );
  });
  return () => {
    stopped = true;
    abortController.abort();
    clearRefreshTimer();
  };
}

export function __resetGatewayModelPricingCacheForTest(): void {
  clearGatewayModelPricingCacheState();
  clearRefreshTimer();
  inFlightRefresh = null;
}
