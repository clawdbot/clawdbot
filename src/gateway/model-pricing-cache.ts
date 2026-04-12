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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveManifestContractPluginIds } from "../plugins/manifest-registry.js";
import { normalizeProviderModelIdWithPlugin } from "../plugins/provider-runtime.js";
import { normalizeOptionalString, resolvePrimaryStringValue } from "../shared/string-coerce.js";
import {
  clearGatewayModelPricingCacheState,
  getCachedGatewayModelPricing,
  getGatewayModelPricingCacheMeta as getGatewayModelPricingCacheMetaState,
  replaceGatewayModelPricingCache,
  type CachedModelPricing,
} from "./model-pricing-cache-state.js";

type OpenRouterPricingEntry = {
  id: string;
  pricing: CachedModelPricing;
};

type ModelListLike = string | { primary?: string; fallbacks?: string[] } | undefined;

type OpenRouterModelPayload = {
  id?: unknown;
  pricing?: unknown;
};

export { getCachedGatewayModelPricing };

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const PROVIDER_ALIAS_TO_OPENROUTER: Record<string, string> = {
  "google-gemini-cli": "google",
  kimi: "moonshotai",
  "kimi-coding": "moonshotai",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  "openai-codex": "openai",
  xai: "x-ai",
  zai: "z-ai",
};
const WRAPPER_PROVIDERS = new Set([
  "cloudflare-ai-gateway",
  "kilocode",
  "openrouter",
  "vercel-ai-gateway",
]);
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

function toPricePerMillion(value: number | null): number {
  if (value === null || value < 0 || !Number.isFinite(value)) {
    return 0;
  }
  return value * 1_000_000;
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

function canonicalizeOpenRouterProvider(provider: string): string {
  const normalized = normalizeModelRef(provider, "placeholder").provider;
  return PROVIDER_ALIAS_TO_OPENROUTER[normalized] ?? normalized;
}

function canonicalizeOpenRouterLookupId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return "";
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return trimmed;
  }
  const provider = canonicalizeOpenRouterProvider(trimmed.slice(0, slash));
  let model = trimmed.slice(slash + 1).trim();
  if (!model) {
    return provider;
  }
  if (provider === "anthropic") {
    model = model
      .replace(/^claude-(\d+)\.(\d+)-/u, "claude-$1-$2-")
      .replace(/^claude-([a-z]+)-(\d+)\.(\d+)$/u, "claude-$1-$2-$3");
  }
  model =
    normalizeProviderModelIdWithPlugin({
      provider,
      context: {
        provider,
        modelId: model,
      },
    }) ?? model;
  return `${provider}/${model}`;
}

function buildOpenRouterExactCandidates(ref: ModelRef, seen = new Set<string>()): string[] {
  const refKey = modelKey(ref.provider, ref.model);
  if (seen.has(refKey)) {
    return [];
  }
  const nextSeen = new Set(seen);
  nextSeen.add(refKey);

  const candidates = new Set<string>();
  const canonicalProvider = canonicalizeOpenRouterProvider(ref.provider);
  const canonicalFullId = canonicalizeOpenRouterLookupId(modelKey(canonicalProvider, ref.model));
  if (canonicalFullId) {
    candidates.add(canonicalFullId);
  }

  if (canonicalProvider === "anthropic") {
    const slash = canonicalFullId.indexOf("/");
    const model = slash === -1 ? canonicalFullId : canonicalFullId.slice(slash + 1);
    const dotted = model
      .replace(/^claude-(\d+)-(\d+)-/u, "claude-$1.$2-")
      .replace(/^claude-([a-z]+)-(\d+)-(\d+)$/u, "claude-$1-$2.$3");
    candidates.add(`${canonicalProvider}/${dotted}`);
  }

  if (WRAPPER_PROVIDERS.has(ref.provider) && ref.model.includes("/")) {
    const nestedRef = parseModelRef(ref.model, DEFAULT_PROVIDER);
    if (nestedRef) {
      for (const candidate of buildOpenRouterExactCandidates(nestedRef, nextSeen)) {
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
}): void {
  const raw = params.raw?.trim();
  if (!raw) {
    return;
  }
  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex: params.aliasIndex,
  });
  if (!resolved) {
    return;
  }
  const normalized = normalizeModelRef(resolved.ref.provider, resolved.ref.model);
  params.refs.set(modelKey(normalized.provider, normalized.model), normalized);
}

function addModelListLike(params: {
  value: ModelListLike;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  refs: Map<string, ModelRef>;
}): void {
  addResolvedModelRef({
    raw: resolvePrimaryStringValue(params.value),
    aliasIndex: params.aliasIndex,
    refs: params.refs,
  });
  for (const fallback of listLikeFallbacks(params.value)) {
    addResolvedModelRef({
      raw: fallback,
      aliasIndex: params.aliasIndex,
      refs: params.refs,
    });
  }
}

function addProviderModelPair(params: {
  provider: string | undefined;
  model: string | undefined;
  refs: Map<string, ModelRef>;
}): void {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return;
  }
  const normalized = normalizeModelRef(provider, model);
  params.refs.set(modelKey(normalized.provider, normalized.model), normalized);
}

function addConfiguredWebSearchPluginModels(params: {
  config: OpenClawConfig;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  refs: Map<string, ModelRef>;
}): void {
  for (const pluginId of resolveManifestContractPluginIds({
    contract: "webSearchProviders",
    config: params.config,
  })) {
    addResolvedModelRef({
      raw: resolvePluginWebSearchConfig(params.config, pluginId)?.model as string | undefined,
      aliasIndex: params.aliasIndex,
      refs: params.refs,
    });
  }
}

export function collectConfiguredModelPricingRefs(config: OpenClawConfig): ModelRef[] {
  const refs = new Map<string, ModelRef>();
  const aliasIndex = buildModelAliasIndex({
    cfg: config,
    defaultProvider: DEFAULT_PROVIDER,
  });

  addModelListLike({ value: config.agents?.defaults?.model, aliasIndex, refs });
  addModelListLike({ value: config.agents?.defaults?.imageModel, aliasIndex, refs });
  addModelListLike({ value: config.agents?.defaults?.pdfModel, aliasIndex, refs });
  addResolvedModelRef({ raw: config.agents?.defaults?.compaction?.model, aliasIndex, refs });
  addResolvedModelRef({ raw: config.agents?.defaults?.heartbeat?.model, aliasIndex, refs });
  addModelListLike({ value: config.tools?.subagents?.model, aliasIndex, refs });
  addResolvedModelRef({ raw: config.messages?.tts?.summaryModel, aliasIndex, refs });
  addResolvedModelRef({ raw: config.hooks?.gmail?.model, aliasIndex, refs });

  for (const agent of config.agents?.list ?? []) {
    addModelListLike({ value: agent.model, aliasIndex, refs });
    addModelListLike({ value: agent.subagents?.model, aliasIndex, refs });
    addResolvedModelRef({ raw: agent.heartbeat?.model, aliasIndex, refs });
  }

  for (const mapping of config.hooks?.mappings ?? []) {
    addResolvedModelRef({ raw: mapping.model, aliasIndex, refs });
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
      });
    }
  }

  addConfiguredWebSearchPluginModels({ config, aliasIndex, refs });

  for (const entry of config.tools?.media?.models ?? []) {
    addProviderModelPair({ provider: entry.provider, model: entry.model, refs });
  }
  for (const entry of config.tools?.media?.image?.models ?? []) {
    addProviderModelPair({ provider: entry.provider, model: entry.model, refs });
  }
  for (const entry of config.tools?.media?.audio?.models ?? []) {
    addProviderModelPair({ provider: entry.provider, model: entry.model, refs });
  }
  for (const entry of config.tools?.media?.video?.models ?? []) {
    addProviderModelPair({ provider: entry.provider, model: entry.model, refs });
  }

  return Array.from(refs.values());
}

async function fetchOpenRouterPricingCatalog(
  fetchImpl: typeof fetch,
): Promise<Map<string, OpenRouterPricingEntry>> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: unknown };
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
  catalogById: Map<string, OpenRouterPricingEntry>;
  catalogByNormalizedId: Map<string, OpenRouterPricingEntry>;
}): CachedModelPricing | undefined {
  for (const candidate of buildOpenRouterExactCandidates(params.ref)) {
    const exact = params.catalogById.get(candidate);
    if (exact) {
      return exact.pricing;
    }
  }
  for (const candidate of buildOpenRouterExactCandidates(params.ref)) {
    const normalized = canonicalizeOpenRouterLookupId(candidate);
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

function scheduleRefresh(params: { config: OpenClawConfig; fetchImpl: typeof fetch }): void {
  clearRefreshTimer();
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshGatewayModelPricingCache(params).catch((error: unknown) => {
      log.warn(`pricing refresh failed: ${String(error)}`);
    });
  }, CACHE_TTL_MS);
}

export async function refreshGatewayModelPricingCache(params: {
  config: OpenClawConfig;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (inFlightRefresh) {
    return await inFlightRefresh;
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  inFlightRefresh = (async () => {
    const refs = collectConfiguredModelPricingRefs(params.config);
    if (refs.length === 0) {
      replaceGatewayModelPricingCache(new Map());
      clearRefreshTimer();
      return;
    }

    const catalogById = await fetchOpenRouterPricingCatalog(fetchImpl);
    const catalogByNormalizedId = new Map<string, OpenRouterPricingEntry>();
    for (const entry of catalogById.values()) {
      const normalizedId = canonicalizeOpenRouterLookupId(entry.id);
      if (!normalizedId || catalogByNormalizedId.has(normalizedId)) {
        continue;
      }
      catalogByNormalizedId.set(normalizedId, entry);
    }

    const nextPricing = new Map<string, CachedModelPricing>();
    for (const ref of refs) {
      const pricing = resolveCatalogPricingForRef({
        ref,
        catalogById,
        catalogByNormalizedId,
      });
      if (!pricing) {
        continue;
      }
      nextPricing.set(modelKey(ref.provider, ref.model), pricing);
    }

    replaceGatewayModelPricingCache(nextPricing);
    scheduleRefresh({ config: params.config, fetchImpl });
  })();

  try {
    await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

export function startGatewayModelPricingRefresh(params: {
  config: OpenClawConfig;
  fetchImpl?: typeof fetch;
}): () => void {
  void refreshGatewayModelPricingCache(params).catch((error: unknown) => {
    log.warn(`pricing bootstrap failed: ${String(error)}`);
  });
  return () => {
    clearRefreshTimer();
  };
}

export function getGatewayModelPricingCacheMeta(): {
  cachedAt: number;
  ttlMs: number;
  size: number;
} {
  return { ...getGatewayModelPricingCacheMetaState(), ttlMs: CACHE_TTL_MS };
}

export function __resetGatewayModelPricingCacheForTest(): void {
  clearGatewayModelPricingCacheState();
  clearRefreshTimer();
  inFlightRefresh = null;
}
