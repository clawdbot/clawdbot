import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import {
  MODEL_PRICING_SOURCES,
  normalizeModelPricingCatalog,
  normalizeModelPricingProvider,
  normalizeOpenRouterModelPricing,
  normalizeUpstreamModelPricing,
  type ModelPricingProvider,
  type ModelPricingSource,
} from "@openclaw/model-catalog-core/model-catalog-pricing";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelCatalogModel } from "../packages/model-catalog-core/src/model-catalog-types.js";
import type {
  RemoteModelCatalogBundle,
  RemoteModelCatalogPricing,
} from "../packages/model-catalog-core/src/remote-catalog-bundle.js";
import { importToolingTypeScript } from "./lib/import-tooling-typescript.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

type ModelCatalogManifestInput = {
  pluginId: string;
  manifestPath: string;
  manifest: {
    providers?: string[];
    modelCatalog?: {
      providers?: Record<string, unknown>;
      modelsDev?: Record<string, unknown>;
      suppressions?: Array<{ provider?: string; model?: string; when?: unknown }>;
    };
    modelPricing?: { providers?: Record<string, unknown> };
  };
};

type PublishedModelPricing = RemoteModelCatalogPricing;
type PublishedModelCatalogBundle = RemoteModelCatalogBundle;
type PricingPolicies = Map<string, ModelPricingProvider>;
type PricingCatalog = Map<string, PublishedModelPricing>;
type PricingSource = (typeof MODEL_PRICING_SOURCES)[number];
type LoadedPricingSource = PricingSource & {
  catalog: PricingCatalog;
  aliases: string[][];
};
type BundleValidator = (bundle: unknown) => PublishedModelCatalogBundle;
type ModelsDevModel = Record<string, unknown> & {
  id: string;
  modalities: { input: unknown[]; output: unknown[] };
  limit: Record<string, unknown>;
};
type ModelCatalogHydrationCounts = { added: number; filled: number; skipped: number };
type ModelCatalogHydrationResult = Record<string, ModelCatalogHydrationCounts>;
type ModelCatalogSourceLoader = (url: string, label: string) => Promise<unknown>;
const MODEL_CATALOG_MIN_VERSION = "2026.7.0";
export const MODEL_CATALOG_MIN_MODELS = 200;

const SCRIPT_LABEL = "publish-model-catalog";
const MODELS_DEV_CATALOG_URL = "https://models.opencode.ai/api.json";
const PRICING_FETCH_TIMEOUT_MS = 60_000;
const MAX_PRICING_CATALOG_BYTES = 5 * 1024 * 1024;
const BUNDLE_SIZE_WARNING_BYTES = 2 * 1024 * 1024;
const CLIENT_BUNDLE_LIMIT_BYTES = 4 * 1024 * 1024;
const defaultRootDir = resolveRepoRoot(import.meta.url);
const NATIVE_CATALOG_PARSER_EXPORTS = {
  cerebras: "parseCerebrasPricingCatalog",
  chutes: "parseChutesPricingCatalog",
  deepinfra: "parseDeepInfraPricingCatalog",
  venice: "parseVenicePricingCatalog",
} satisfies Record<
  Exclude<Extract<PricingSource, { authoritative: true }>["id"], "openCode">,
  string
>;

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePublishModelCatalogArgs(args: string[]) {
  let dryRun = false;
  let pricing = false;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--pricing") {
      pricing = true;
      continue;
    }
    if (arg === "--out") {
      out = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!dryRun && !out) {
    throw new Error("provide --out <file> or --dry-run");
  }
  return { dryRun, pricing, ...(out ? { out } : {}) };
}

export function readModelCatalogManifests(
  options: { rootDir?: string } = {},
): ModelCatalogManifestInput[] {
  const rootDir = options.rootDir ?? defaultRootDir;
  const extensionsDir = path.join(rootDir, "extensions");
  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      pluginId: entry.name,
      manifestPath: path.join(extensionsDir, entry.name, "openclaw.plugin.json"),
    }))
    .filter((entry) => fs.existsSync(entry.manifestPath))
    .map((entry) => ({
      pluginId: entry.pluginId,
      manifestPath: entry.manifestPath,
      manifest: JSON.parse(fs.readFileSync(entry.manifestPath, "utf8")),
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

async function loadClientBundleValidator() {
  const modulePath = path.join(
    defaultRootDir,
    "packages/model-catalog-core/src/remote-catalog-bundle.ts",
  );
  const module = await importToolingTypeScript(pathToFileURL(modulePath).href, import.meta.url);
  if (typeof module.validateAndSanitizeRemoteModelCatalogBundle !== "function") {
    throw new Error("remote catalog bundle validator export is unavailable");
  }
  return module.validateAndSanitizeRemoteModelCatalogBundle;
}

export async function assembleModelCatalogBundle(options: {
  manifests: ModelCatalogManifestInput[];
  generatedAt: number;
  sourceCommit: string;
  minVersion?: string;
  validateBundle?: BundleValidator;
}): Promise<PublishedModelCatalogBundle> {
  const providers: Record<string, unknown> = {};
  for (const entry of options.manifests) {
    const declaredProviders = entry.manifest?.modelCatalog?.providers;
    if (!isRecord(declaredProviders)) {
      continue;
    }
    for (const [providerId, provider] of Object.entries(declaredProviders)) {
      if (Object.hasOwn(providers, providerId)) {
        throw new Error(`provider ${providerId} is declared by more than one plugin manifest`);
      }
      providers[providerId] = provider;
    }
  }

  if (!Object.hasOwn(providers, "anthropic") || !Object.hasOwn(providers, "openai")) {
    throw new Error("catalog must include anthropic and openai providers");
  }
  const bundle = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    minVersion: options.minVersion ?? MODEL_CATALOG_MIN_VERSION,
    sourceCommit: options.sourceCommit,
    providers,
  };
  const validateBundle = options.validateBundle ?? (await loadClientBundleValidator());
  const validated = validateBundle(bundle);
  const summary = summarizeModelCatalogBundle(validated);
  if (summary.models < MODEL_CATALOG_MIN_MODELS) {
    throw new Error(
      `catalog model count ${summary.models} is below required floor ${MODEL_CATALOG_MIN_MODELS}`,
    );
  }
  return validated;
}

export function summarizeModelCatalogBundle(bundle: PublishedModelCatalogBundle) {
  const providerRows = Object.values(bundle.providers);
  return {
    providers: providerRows.length,
    models: providerRows.reduce((total, provider) => total + provider.models.length, 0),
    costModels: providerRows.reduce(
      (total, provider) => total + provider.models.filter((model) => model.cost).length,
      0,
    ),
    pricingEntries: Object.keys(bundle.pricing ?? {}).length,
  };
}

function toPricePerMillion(value: number | undefined): number {
  return value === undefined || value < 0 ? 0 : value * 1_000_000;
}

function parseLiteLLMTieredPricing(
  value: unknown,
): PublishedModelPricing["tieredPricing"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tiers: NonNullable<PublishedModelPricing["tieredPricing"]> = [];
  for (const raw of value) {
    if (!isRecord(raw) || !Array.isArray(raw.range)) {
      continue;
    }
    const input = parseStrictFiniteNumber(raw.input_cost_per_token);
    const output = parseStrictFiniteNumber(raw.output_cost_per_token);
    const start = parseStrictFiniteNumber(raw.range[0]);
    if (
      input === undefined ||
      output === undefined ||
      start === undefined ||
      input < 0 ||
      output < 0
    ) {
      continue;
    }
    const rawEnd = raw.range.length >= 2 ? parseStrictFiniteNumber(raw.range[1]) : undefined;
    const range: [number] | [number, number] =
      rawEnd === undefined || rawEnd <= start ? [start] : [start, rawEnd];
    tiers.push({
      input: toPricePerMillion(input),
      output: toPricePerMillion(output),
      cacheRead: toPricePerMillion(parseStrictFiniteNumber(raw.cache_read_input_token_cost)),
      cacheWrite: toPricePerMillion(parseStrictFiniteNumber(raw.cache_creation_input_token_cost)),
      range,
    });
  }
  return tiers.length > 0
    ? tiers.toSorted((left, right) => left.range[0] - right.range[0])
    : undefined;
}

function parseLiteLLMPricing(value: unknown): PublishedModelPricing | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const input = parseStrictFiniteNumber(value.input_cost_per_token);
  const output = parseStrictFiniteNumber(value.output_cost_per_token);
  if (input === undefined || output === undefined || input < 0 || output < 0) {
    return undefined;
  }
  const tieredPricing = parseLiteLLMTieredPricing(value.tiered_pricing);
  return {
    input: toPricePerMillion(input),
    output: toPricePerMillion(output),
    cacheRead: toPricePerMillion(parseStrictFiniteNumber(value.cache_read_input_token_cost)),
    cacheWrite: toPricePerMillion(parseStrictFiniteNumber(value.cache_creation_input_token_cost)),
    ...(tieredPricing ? { tieredPricing } : {}),
  };
}

function compactPricing(pricing: PublishedModelPricing): PublishedModelPricing {
  return {
    input: pricing.input,
    output: pricing.output,
    ...((pricing.cacheRead ?? 0) > 0 ? { cacheRead: pricing.cacheRead } : {}),
    ...((pricing.cacheWrite ?? 0) > 0 ? { cacheWrite: pricing.cacheWrite } : {}),
    ...(pricing.tieredPricing ? { tieredPricing: pricing.tieredPricing } : {}),
  };
}

function hasKnownPricing(pricing: Partial<PublishedModelPricing>): boolean {
  return (
    (pricing.input ?? 0) > 0 ||
    (pricing.output ?? 0) > 0 ||
    (pricing.cacheRead ?? 0) > 0 ||
    (pricing.cacheWrite ?? 0) > 0 ||
    Boolean(pricing.tieredPricing?.some(hasKnownPricing))
  );
}

function modelIdVariants(modelId: string, transforms?: string[], reverse = false): string[] {
  if (!transforms?.includes("version-dots")) {
    return [modelId];
  }
  const variant = reverse
    ? modelId
        .replace(/^claude-(\d+)\.(\d+)-/u, "claude-$1-$2-")
        .replace(/^claude-([a-z]+)-(\d+)\.(\d+)$/u, "claude-$1-$2-$3")
    : modelId
        .replace(/^claude-(\d+)-(\d+)-/u, "claude-$1.$2-")
        .replace(/^claude-([a-z]+)-(\d+)-(\d+)$/u, "claude-$1-$2.$3");
  return [...new Set([modelId, variant])];
}

function sourcePolicy(
  policies: PricingPolicies,
  providerId: string,
  source: PricingSource,
): ModelPricingSource | undefined {
  const policy = policies.get(providerId);
  const selected = policy?.[source.id];
  if (
    policy?.external === false ||
    selected === false ||
    (!selected && (policy || source.authoritative))
  ) {
    return undefined;
  }
  return selected ?? {};
}

function buildPricingCandidates(
  providerId: string,
  modelId: string,
  source: PricingSource,
  policies: PricingPolicies,
  seen = new Set<string>(),
): string[] {
  const ref = `${providerId}/${modelId}`;
  const policy = sourcePolicy(policies, providerId, source);
  if (seen.has(ref) || !policy) {
    return [];
  }
  const candidates = modelIdVariants(modelId, policy.modelIdTransforms).map(
    (id) => `${policy.provider ?? providerId}/${id}`,
  );
  const slash = modelId.indexOf("/");
  if (policy.passthroughProviderModel && slash > 0) {
    candidates.push(
      ...buildPricingCandidates(
        modelId.slice(0, slash),
        modelId.slice(slash + 1),
        source,
        policies,
        new Set(seen).add(ref),
      ),
    );
  }
  return [...new Set(candidates)];
}

function readPricingPolicies(manifests: ModelCatalogManifestInput[]): PricingPolicies {
  const policies: PricingPolicies = new Map();
  for (const { manifest } of manifests) {
    const owners = new Set((manifest.providers ?? []).map(normalizeModelCatalogProviderId));
    for (const [rawId, value] of Object.entries(manifest.modelPricing?.providers ?? {})) {
      const id = normalizeModelCatalogProviderId(rawId);
      const policy = owners.has(id) ? normalizeModelPricingProvider(value) : undefined;
      if (policy) {
        policies.set(id, policy);
      }
    }
  }
  return policies;
}

async function readJsonResponse(response: Response, source: string) {
  if (!response.ok) {
    throw new Error(`${source} request failed: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PRICING_CATALOG_BYTES) {
    throw new Error(`${source} response exceeds ${MAX_PRICING_CATALOG_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`${source} response has no body`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_PRICING_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error(`${source} response exceeds ${MAX_PRICING_CATALOG_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${source} response is malformed JSON`);
  }
  return payload;
}

function createModelCatalogSourceLoader(fetchImpl: typeof fetch = fetch): ModelCatalogSourceLoader {
  // Metadata and pricing consume the same response within one publication. A failed
  // metadata request must not be retried as pricing and publish a smaller catalog.
  const sources = new Map<string, Promise<unknown>>();
  return (url, label) => {
    let source = sources.get(url);
    if (!source) {
      source = fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS),
      })
        .then((response) => readJsonResponse(response, label))
        .catch((cause: unknown) => {
          throw new Error(`${label} catalog unavailable: ${String(cause)}`, { cause });
        });
      sources.set(url, source);
    }
    return source;
  };
}

function isModelsDevModel(value: unknown, modelId: string): value is ModelsDevModel {
  return (
    isRecord(value) &&
    value.id === modelId &&
    isRecord(value.modalities) &&
    Array.isArray(value.modalities.input) &&
    Array.isArray(value.modalities.output) &&
    isRecord(value.limit)
  );
}

// Metadata only: cost stays with the provider pricing policy in enrichModelCatalogPricing.
function translateModelsDevModel(model: ModelsDevModel): ModelCatalogModel {
  const contextWindow = parseStrictFiniteNumber(model.limit.context);
  const maxTokens = parseStrictFiniteNumber(model.limit.output);
  return {
    id: model.id,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    input: [
      ...new Set(
        model.modalities.input.flatMap((value) =>
          value === "text" || value === "image" ? value : value === "pdf" ? "document" : [],
        ),
      ),
    ],
    ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
  };
}

const HYDRATED_MODEL_FIELDS = [
  "name",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
] as const satisfies readonly (keyof ModelCatalogModel)[];

export async function hydrateModelCatalogFromModelsDev(options: {
  bundle: PublishedModelCatalogBundle;
  manifests: ModelCatalogManifestInput[];
  fetchImpl?: typeof fetch;
  loadSource?: ModelCatalogSourceLoader;
}): Promise<ModelCatalogHydrationResult> {
  const result: ModelCatalogHydrationResult = {};
  const mappings = new Map<string, string>();
  const suppressions = new Set<string>();
  for (const { manifest } of options.manifests) {
    const ownedProviders = new Set((manifest.providers ?? []).map(normalizeModelCatalogProviderId));
    const catalog = normalizeModelCatalog(manifest.modelCatalog, { ownedProviders });
    for (const [provider, source] of Object.entries(catalog?.modelsDev ?? {})) {
      if (catalog?.providers?.[provider] && options.bundle.providers[provider]) {
        mappings.set(provider, source);
      }
    }
    // Endpoint-specific rules remain runtime-owned. Another plugin cannot veto
    // an owner's imports through an unowned shared-catalog suppression.
    for (const { provider, model, when } of catalog?.suppressions ?? []) {
      if (ownedProviders.has(provider) && when === undefined) {
        suppressions.add(`${provider}/${model.toLowerCase()}`);
      }
    }
  }
  if (mappings.size === 0) {
    return result;
  }
  const loadSource = options.loadSource ?? createModelCatalogSourceLoader(options.fetchImpl);
  const catalog = await loadSource(MODELS_DEV_CATALOG_URL, "models.dev");
  if (!isRecord(catalog)) {
    throw new Error("models.dev response is not a JSON object");
  }
  for (const [providerId, provider] of Object.entries(options.bundle.providers)) {
    const upstreamProviderId = mappings.get(providerId);
    if (!upstreamProviderId) {
      continue;
    }
    const upstreamProvider = catalog[upstreamProviderId];
    if (
      !isRecord(upstreamProvider) ||
      upstreamProvider.id !== upstreamProviderId ||
      !isRecord(upstreamProvider.models)
    ) {
      throw new Error(`models.dev catalog missing or malformed for provider ${upstreamProviderId}`);
    }
    if (provider.models.some((model) => model.api !== undefined)) {
      process.stderr.write(
        `[${SCRIPT_LABEL}] warning: skipping models.dev hydration for ${providerId}; its rows pick a transport per model\n`,
      );
      continue;
    }
    const existing = new Map(provider.models.map((model) => [model.id, model]));
    let filled = 0;
    let skipped = 0;
    const additions = Object.entries(upstreamProvider.models).flatMap(([modelId, rawModel]) => {
      // Agents need tool calling; models.dev rows without it are embeddings, image, guard, and
      // safety models that would only clutter the picker.
      if (
        !isModelsDevModel(rawModel, modelId) ||
        rawModel.tool_call !== true ||
        !rawModel.modalities.output.includes("text") ||
        rawModel.status === "deprecated" ||
        rawModel.status === "retired" ||
        suppressions.has(`${providerId}/${modelId.toLowerCase()}`)
      ) {
        skipped += 1;
        return [];
      }
      const current = existing.get(modelId);
      if (!current) {
        return [translateModelsDevModel(rawModel)];
      }
      const translated = translateModelsDevModel(rawModel);
      let modelFilled = false;
      for (const key of HYDRATED_MODEL_FIELDS) {
        if (current[key] === undefined && translated[key] !== undefined) {
          Object.assign(current, { [key]: translated[key] });
          modelFilled = true;
        }
      }
      if (modelFilled) {
        filled += 1;
      }
      return [];
    });
    provider.models.push(...additions);
    result[providerId] = { added: additions.length, filled, skipped };
  }
  return result;
}

async function parsePricingCatalog(
  source: PricingSource,
  body: unknown,
  policies: PricingPolicies,
): Promise<LoadedPricingSource> {
  const catalog: PricingCatalog = new Map();
  const aliases: string[][] = [];
  if (source.authoritative && source.id !== "openCode") {
    const moduleUrl = new URL(`../extensions/${source.id}/pricing-api.ts`, import.meta.url).href;
    const module = await importToolingTypeScript(moduleUrl, import.meta.url);
    const parser = module[NATIVE_CATALOG_PARSER_EXPORTS[source.id]];
    if (typeof parser !== "function") {
      throw new Error(`${source.label} pricing parser export is unavailable`);
    }
    const prices = parser(body);
    if (!prices) {
      throw new Error(`${source.label} pricing response is malformed`);
    }
    for (const [id, pricing] of prices) {
      catalog.set(`${source.id}/${id}`, pricing);
    }
    return { ...source, catalog, aliases };
  }
  if (!isRecord(body)) {
    throw new Error(`${source.label} response is not a JSON object`);
  }
  if (source.id === "openCode") {
    for (const [providerId] of policies) {
      const policy = sourcePolicy(policies, providerId, source);
      if (!policy) {
        continue;
      }
      const upstreamId = policy.provider ?? providerId;
      const provider = body[upstreamId];
      if (!isRecord(provider) || provider.id !== upstreamId || !isRecord(provider.models)) {
        throw new Error(`${source.label} pricing missing provider ${upstreamId}`);
      }
      const rows = Object.entries(provider.models).map(([id, model]) =>
        isRecord(model) && model.id === id ? model : undefined,
      );
      const prices = normalizeModelPricingCatalog(rows, normalizeUpstreamModelPricing, {
        readPricing: (model) => model.cost,
      });
      if (!prices) {
        throw new Error(`${source.label} pricing malformed for provider ${upstreamId}`);
      }
      for (const [id, pricing] of prices) {
        catalog.set(`${upstreamId}/${id}`, pricing);
      }
    }
  } else if (source.id === "openRouter") {
    for (const row of Array.isArray(body.data) ? body.data : []) {
      if (!isRecord(row)) {
        continue;
      }
      const pricing = normalizeOpenRouterModelPricing(row.pricing);
      if (typeof row.id === "string" && pricing) {
        catalog.set(row.id, pricing);
      }
    }
  } else {
    for (const [id, row] of Object.entries(body)) {
      const pricing = parseLiteLLMPricing(row);
      if (!pricing || !isRecord(row)) {
        continue;
      }
      const keys = [id];
      if (typeof row.litellm_provider === "string" && !id.includes("/")) {
        keys.push(`${row.litellm_provider}/${id}`);
      }
      for (const key of keys) {
        catalog.set(key, pricing);
      }
      aliases.push(keys);
    }
  }
  return { ...source, catalog, aliases };
}

async function fetchPricingSources(
  loadSource: ModelCatalogSourceLoader,
  policies: PricingPolicies,
) {
  const sources = MODEL_PRICING_SOURCES.filter(
    (source) =>
      !source.authoritative ||
      [...policies.keys()].some((id) => sourcePolicy(policies, id, source)),
  );
  const loaded = await Promise.all(
    sources.map(async (source) => {
      try {
        const body = await loadSource(source.url, source.label);
        return await parsePricingCatalog(source, body, policies);
      } catch (cause) {
        return {
          source,
          error: new Error(`${source.label} pricing unavailable: ${String(cause)}`, { cause }),
        };
      }
    }),
  );
  // Join all fetches before the final failure marker, and never re-stamp stale owner prices.
  const failure = loaded.find((entry) => "error" in entry && entry.source.authoritative);
  if (failure && "error" in failure) {
    throw failure.error;
  }
  const result: LoadedPricingSource[] = [];
  for (const entry of loaded) {
    if ("error" in entry) {
      process.stderr.write(`[${SCRIPT_LABEL}] warning: ${entry.error.message}\n`);
      result.push({ ...entry.source, catalog: new Map(), aliases: [] });
    } else {
      result.push(entry);
    }
  }
  return result;
}

function selectProviderPricingSources(
  providerId: string,
  sources: LoadedPricingSource[],
  policies: PricingPolicies,
): LoadedPricingSource[] {
  const eligible = sources.filter((source) => sourcePolicy(policies, providerId, source));
  // A native feed owns unavailable prices too; other vendors cannot fill its gaps.
  const native = eligible.find((source) => source.authoritative);
  return native ? [native] : eligible;
}

function materializePolicyRuntimePricing(
  hosted: PricingCatalog,
  policies: PricingPolicies,
  sources: LoadedPricingSource[],
  metadataOwnedKeys: Set<string>,
): void {
  for (const [providerId] of policies) {
    for (const key of hosted.keys()) {
      if (key.startsWith(`${providerId}/`)) {
        hosted.delete(key);
      }
    }
    for (const source of selectProviderPricingSources(providerId, sources, policies)) {
      const policy = sourcePolicy(policies, providerId, source);
      if (!policy) {
        continue;
      }
      for (const [key, pricing] of source.catalog) {
        if (!source.authoritative && !hasKnownPricing(pricing)) {
          continue;
        }
        const slash = key.indexOf("/");
        if (slash <= 0 || slash === key.length - 1) {
          continue;
        }
        const runtimeKeys =
          key.slice(0, slash) === (policy.provider ?? providerId)
            ? modelIdVariants(key.slice(slash + 1), policy.modelIdTransforms, true).map(
                (id) => `${providerId}/${id}`,
              )
            : [];
        if (policy.passthroughProviderModel) {
          runtimeKeys.push(`${providerId}/${key}`);
        }
        for (const runtimeKey of runtimeKeys) {
          if (!metadataOwnedKeys.has(runtimeKey) && !hosted.has(runtimeKey)) {
            hosted.set(runtimeKey, pricing);
          }
        }
      }
    }
  }
}

export async function enrichModelCatalogPricing(options: {
  bundle: PublishedModelCatalogBundle;
  manifests: ModelCatalogManifestInput[];
  fetchImpl?: typeof fetch;
  loadSource?: ModelCatalogSourceLoader;
}): Promise<{ modelsEnriched: number; pricingEntries: number }> {
  const policies = readPricingPolicies(options.manifests);
  const sources = await fetchPricingSources(
    options.loadSource ?? createModelCatalogSourceLoader(options.fetchImpl),
    policies,
  );
  let enriched = 0;
  const coveredKeys = new Set<string>();
  const metadataOwnedKeys = new Set<string>();
  for (const [providerId, provider] of Object.entries(options.bundle.providers)) {
    const providerSources = selectProviderPricingSources(providerId, sources, policies);
    for (const model of provider.models) {
      const matches = providerSources.map((source) => {
        const candidates = buildPricingCandidates(providerId, model.id, source, policies);
        return {
          source,
          candidates,
          pricing: candidates.map((key) => source.catalog.get(key)).find(Boolean),
        };
      });
      // Flat third-party estimates cannot replace a declared context-price schedule.
      // Native feeds remain authoritative, including removal of old tiers or prices.
      const chosen = matches.find(
        ({ source, pricing }) =>
          source.authoritative ||
          (pricing &&
            hasKnownPricing(pricing) &&
            (!model.cost?.tieredPricing?.length || pricing.tieredPricing?.length)),
      );
      if (chosen?.pricing) {
        model.cost = chosen.pricing;
        enriched += 1;
      } else if (chosen) {
        // Keep the metadata row: removing it would revive the bundled seed's stale price.
        delete model.cost;
        process.stderr.write(
          `[${SCRIPT_LABEL}] warning: ${chosen.source.label} pricing unavailable for ${providerId}/${model.id}; preserving metadata without cost\n`,
        );
      }
      // Native zero prices keep standalone entries as evidence of free, not unknown, usage.
      if ((model.cost && hasKnownPricing(model.cost)) || (chosen && !chosen.pricing)) {
        const key = `${providerId}/${model.id}`;
        coveredKeys.add(key);
        metadataOwnedKeys.add(key);
        for (const { candidates } of matches) {
          for (const candidate of candidates) {
            coveredKeys.add(candidate);
          }
        }
      }
    }
  }

  const hosted: PricingCatalog = new Map();
  for (const source of sources) {
    // Opted-in feeds only enter the owner's mapped namespace, never the global fallback map.
    if (!source.authoritative) {
      for (const [key, pricing] of source.catalog) {
        const existing = hosted.get(key);
        if (!existing || !hasKnownPricing(existing)) {
          hosted.set(key, pricing);
        }
      }
    }
    for (const aliases of source.aliases) {
      if (aliases.some((key) => coveredKeys.has(key))) {
        for (const key of aliases) {
          coveredKeys.add(key);
        }
      }
    }
  }
  for (const key of coveredKeys) {
    hosted.delete(key);
  }
  materializePolicyRuntimePricing(hosted, policies, sources, metadataOwnedKeys);
  options.bundle.pricing = Object.fromEntries(
    [...hosted.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, pricing]) => [key, compactPricing(pricing)]),
  );
  return { modelsEnriched: enriched, pricingEntries: hosted.size };
}

function sortCatalogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCatalogValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortCatalogValue(entry)]),
  );
}

export function serializeModelCatalogBundle(bundle: PublishedModelCatalogBundle): string {
  const providers = Object.fromEntries(
    Object.entries(bundle.providers)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([providerId, provider]) => [
        providerId,
        {
          ...provider,
          models: provider.models.toSorted((left, right) => left.id.localeCompare(right.id)),
        },
      ]),
  );
  return `${JSON.stringify(sortCatalogValue({ ...bundle, providers }), null, 2)}\n`;
}

function resolveSourceCommit(rootDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

async function runPublishModelCatalog(
  options: {
    args?: string[];
    fetchImpl?: typeof fetch;
    now?: () => number;
    rootDir?: string;
    sourceCommit?: string;
  } = {},
) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const args = parsePublishModelCatalogArgs(options.args ?? process.argv.slice(2));
  const generatedAt = (options.now ?? Date.now)();
  const sourceCommit = options.sourceCommit ?? resolveSourceCommit(rootDir);
  const manifests = readModelCatalogManifests({ rootDir });
  let bundle = await assembleModelCatalogBundle({ manifests, generatedAt, sourceCommit });
  const loadSource = createModelCatalogSourceLoader(options.fetchImpl);
  const hydrationResult = await hydrateModelCatalogFromModelsDev({ bundle, manifests, loadSource });
  const pricingResult = args.pricing
    ? await enrichModelCatalogPricing({ bundle, manifests, loadSource })
    : { modelsEnriched: 0, pricingEntries: 0 };
  // Validate after all enrichment so metadata-only and dry-run output obey the
  // same client contract as priced catalogs.
  const validateBundle = await loadClientBundleValidator();
  bundle = validateBundle(bundle);
  const summary = summarizeModelCatalogBundle(bundle);
  const serialized = serializeModelCatalogBundle(bundle);
  const bundleBytes = Buffer.byteLength(serialized);
  if (bundleBytes > BUNDLE_SIZE_WARNING_BYTES) {
    process.stderr.write(
      `[${SCRIPT_LABEL}] warning: bundle size ${bundleBytes} bytes exceeds ${BUNDLE_SIZE_WARNING_BYTES} bytes\n`,
    );
  }
  if (bundleBytes > CLIENT_BUNDLE_LIMIT_BYTES) {
    throw new Error(
      `catalog bundle ${bundleBytes} bytes exceeds client limit ${CLIENT_BUNDLE_LIMIT_BYTES} bytes`,
    );
  }
  const hydrationSummary = Object.entries(hydrationResult)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([providerId, { added, filled, skipped }]) =>
        `[${SCRIPT_LABEL}] models.dev provider=${providerId} added=${added} filled=${filled} skipped=${skipped}\n`,
    )
    .join("");
  const stats = `schemaVersion=1 providers=${summary.providers} models=${summary.models} costModels=${summary.costModels} pricingEnriched=${pricingResult.modelsEnriched} pricingEntries=${pricingResult.pricingEntries} bundleBytes=${bundleBytes} generatedAt=${bundle.generatedAt} minVersion=${bundle.minVersion} sourceCommit=${bundle.sourceCommit}`;
  if (args.dryRun) {
    process.stdout.write(`[${SCRIPT_LABEL}] dry-run ${stats}\n${hydrationSummary}`);
    return { bundle, summary, pricingEnriched: pricingResult.modelsEnriched, wrote: false };
  }
  if (!args.out) {
    throw new Error("output path is required outside dry-run mode");
  }
  const outputFile = path.resolve(rootDir, args.out);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, serialized);
  process.stdout.write(`[${SCRIPT_LABEL}] published ${stats} out=${args.out}\n${hydrationSummary}`);
  return { bundle, summary, pricingEnriched: pricingResult.modelsEnriched, wrote: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runPublishModelCatalog();
  } catch (error) {
    const errorExitCode =
      error && typeof error === "object" && "exitCode" in error ? error.exitCode : undefined;
    const exitCode =
      typeof errorExitCode === "number" && Number.isInteger(errorExitCode) ? errorExitCode : 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`[${SCRIPT_LABEL}] FAILED (exit ${exitCode})\n`);
    process.exitCode = exitCode;
  }
}
