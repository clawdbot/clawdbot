import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const MODEL_CATALOG_MIN_VERSION = "2026.7.0";
export const MODEL_CATALOG_MIN_MODELS = 200;
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const SCRIPT_LABEL = "publish-model-catalog";
const PRICING_FETCH_TIMEOUT_MS = 60_000;
const MAX_PRICING_CATALOG_BYTES = 5 * 1024 * 1024;
const BUNDLE_SIZE_WARNING_BYTES = 2 * 1024 * 1024;
const CLIENT_BUNDLE_LIMIT_BYTES = 4 * 1024 * 1024;
const defaultRootDir = resolveRepoRoot(import.meta.url);

function requireOptionValue(args, index, flag) {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePublishModelCatalogArgs(args) {
  const options = { dryRun: false, pricing: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--pricing") {
      options.pricing = true;
      continue;
    }
    if (arg === "--out") {
      options.out = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.dryRun && !options.out) {
    throw new Error("provide --out <file> or --dry-run");
  }
  return options;
}

export function readModelCatalogManifests(options = {}) {
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
  const { tsImport } = await import("tsx/esm/api");
  const modulePath = path.join(
    defaultRootDir,
    "packages/model-catalog-core/src/remote-catalog-bundle.ts",
  );
  const module = await tsImport(pathToFileURL(modulePath).href, import.meta.url);
  if (typeof module.validateAndSanitizeRemoteModelCatalogBundle !== "function") {
    throw new Error("remote catalog bundle validator export is unavailable");
  }
  return module.validateAndSanitizeRemoteModelCatalogBundle;
}

export async function assembleModelCatalogBundle(options) {
  const providers = {};
  for (const entry of options.manifests) {
    const declaredProviders = entry.manifest?.modelCatalog?.providers;
    if (
      !declaredProviders ||
      typeof declaredProviders !== "object" ||
      Array.isArray(declaredProviders)
    ) {
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

export function summarizeModelCatalogBundle(bundle) {
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

function parseNumberString(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function toPricePerMillion(value) {
  return value === null || value < 0 || !Number.isFinite(value) ? 0 : value * 1_000_000;
}

function parseOpenRouterPricing(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const prompt = parseNumberString(value.prompt);
  const completion = parseNumberString(value.completion);
  if (prompt === null || completion === null || prompt < 0 || completion < 0) {
    return null;
  }
  return {
    input: toPricePerMillion(prompt),
    output: toPricePerMillion(completion),
    cacheRead: toPricePerMillion(parseNumberString(value.input_cache_read)),
    cacheWrite: toPricePerMillion(parseNumberString(value.input_cache_write)),
  };
}

function parseLiteLLMTieredPricing(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tiers = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.range)) {
      continue;
    }
    const input = parseNumberString(raw.input_cost_per_token);
    const output = parseNumberString(raw.output_cost_per_token);
    const start = parseNumberString(raw.range[0]);
    if (input === null || output === null || start === null || input < 0 || output < 0) {
      continue;
    }
    const rawEnd = raw.range.length >= 2 ? parseNumberString(raw.range[1]) : null;
    tiers.push({
      input: toPricePerMillion(input),
      output: toPricePerMillion(output),
      cacheRead: toPricePerMillion(parseNumberString(raw.cache_read_input_token_cost)),
      cacheWrite: toPricePerMillion(parseNumberString(raw.cache_creation_input_token_cost)),
      range: rawEnd === null || rawEnd <= start ? [start] : [start, rawEnd],
    });
  }
  return tiers.length > 0
    ? tiers.toSorted((left, right) => left.range[0] - right.range[0])
    : undefined;
}

function parseLiteLLMPricing(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = parseNumberString(value.input_cost_per_token);
  const output = parseNumberString(value.output_cost_per_token);
  if (input === null || output === null || input < 0 || output < 0) {
    return null;
  }
  const tieredPricing = parseLiteLLMTieredPricing(value.tiered_pricing);
  return {
    input: toPricePerMillion(input),
    output: toPricePerMillion(output),
    cacheRead: toPricePerMillion(parseNumberString(value.cache_read_input_token_cost)),
    cacheWrite: toPricePerMillion(parseNumberString(value.cache_creation_input_token_cost)),
    ...(tieredPricing ? { tieredPricing } : {}),
  };
}

function compactPricing(pricing) {
  return {
    input: pricing.input,
    output: pricing.output,
    ...(pricing.cacheRead > 0 ? { cacheRead: pricing.cacheRead } : {}),
    ...(pricing.cacheWrite > 0 ? { cacheWrite: pricing.cacheWrite } : {}),
    ...(pricing.tieredPricing ? { tieredPricing: pricing.tieredPricing } : {}),
  };
}

function mergePricing(primary, secondary) {
  if (!primary || !hasKnownPricing(primary)) {
    return secondary;
  }
  if (!secondary || !hasKnownPricing(secondary)) {
    return primary;
  }
  if (!secondary?.tieredPricing) {
    return primary;
  }
  return { ...primary, tieredPricing: secondary.tieredPricing };
}

function hasKnownPricing(pricing) {
  return (
    (pricing.input ?? 0) > 0 ||
    (pricing.output ?? 0) > 0 ||
    (pricing.cacheRead ?? 0) > 0 ||
    (pricing.cacheWrite ?? 0) > 0 ||
    Boolean(
      pricing.tieredPricing?.some(
        (tier) => tier.input > 0 || tier.output > 0 || tier.cacheRead > 0 || tier.cacheWrite > 0,
      ),
    )
  );
}

function applyModelIdTransforms(modelId, transforms) {
  const variants = new Set([modelId]);
  for (const transform of transforms ?? []) {
    if (transform !== "version-dots") {
      continue;
    }
    for (const variant of Array.from(variants)) {
      variants.add(
        variant
          .replace(/^claude-(\d+)-(\d+)-/u, "claude-$1.$2-")
          .replace(/^claude-([a-z]+)-(\d+)-(\d+)$/u, "claude-$1-$2.$3"),
      );
    }
  }
  return [...variants];
}

function buildPricingCandidates({ providerId, modelId, source, policies, seen = new Set() }) {
  const ref = `${providerId}/${modelId}`;
  if (seen.has(ref)) {
    return [];
  }
  const nextSeen = new Set(seen).add(ref);
  const policy = policies.get(providerId);
  if (policy?.external === false) {
    return [];
  }
  const sourcePolicy = policy?.[source];
  if (policy && !sourcePolicy) {
    return [];
  }
  const externalProvider = sourcePolicy?.provider ?? providerId;
  const candidates = new Set(
    applyModelIdTransforms(modelId, sourcePolicy?.modelIdTransforms).map(
      (candidate) => `${externalProvider}/${candidate}`,
    ),
  );
  if (sourcePolicy?.passthroughProviderModel && modelId.includes("/")) {
    const slash = modelId.indexOf("/");
    for (const candidate of buildPricingCandidates({
      providerId: modelId.slice(0, slash),
      modelId: modelId.slice(slash + 1),
      source,
      policies,
      seen: nextSeen,
    })) {
      candidates.add(candidate);
    }
  }
  return [...candidates];
}

function reverseModelIdTransforms(modelId, transforms) {
  const variants = new Set([modelId]);
  for (const transform of transforms ?? []) {
    if (transform !== "version-dots") {
      continue;
    }
    for (const variant of Array.from(variants)) {
      variants.add(
        variant
          .replace(/^claude-(\d+)\.(\d+)-/u, "claude-$1-$2-")
          .replace(/^claude-([a-z]+)-(\d+)\.(\d+)$/u, "claude-$1-$2-$3"),
      );
    }
  }
  return [...variants];
}

function setRuntimePricingSource(entries, key, source, pricing) {
  const entry = entries.get(key) ?? {};
  entry[source] = pricing;
  entries.set(key, entry);
}

function collectPolicyRuntimePricingAliases({ providerId, policy, source, catalog, entries }) {
  const rawSourcePolicy = policy?.[source];
  const sourceEnabled = Boolean(rawSourcePolicy);
  const sourcePolicy = sourceEnabled ? rawSourcePolicy : {};
  const sourceProvider = sourcePolicy.provider ?? providerId;
  for (const [sourceKey, pricing] of catalog) {
    const slash = sourceKey.indexOf("/");
    if (slash <= 0 || slash === sourceKey.length - 1) {
      continue;
    }
    const keyProvider = sourceKey.slice(0, slash);
    const sourceModel = sourceKey.slice(slash + 1);
    if (keyProvider === sourceProvider) {
      for (const runtimeModel of reverseModelIdTransforms(
        sourceModel,
        sourcePolicy.modelIdTransforms,
      )) {
        setRuntimePricingSource(
          entries,
          `${providerId}/${runtimeModel}`,
          source,
          sourceEnabled ? pricing : undefined,
        );
      }
    }
    if (sourceEnabled && sourcePolicy.passthroughProviderModel) {
      setRuntimePricingSource(entries, `${providerId}/${sourceKey}`, source, pricing);
    }
  }
}

function materializePolicyRuntimePricing({
  hostedPricing,
  policies,
  openRouterCatalog,
  liteLlmCatalog,
  pricedProviderModelKeys,
}) {
  for (const [providerId, policy] of policies) {
    for (const key of hostedPricing.keys()) {
      if (key.startsWith(`${providerId}/`)) {
        hostedPricing.delete(key);
      }
    }
    if (policy?.external === false) {
      continue;
    }
    const entries = new Map();
    collectPolicyRuntimePricingAliases({
      providerId,
      policy,
      source: "openRouter",
      catalog: openRouterCatalog,
      entries,
    });
    collectPolicyRuntimePricingAliases({
      providerId,
      policy,
      source: "liteLLM",
      catalog: liteLlmCatalog,
      entries,
    });
    for (const [key, entry] of entries) {
      if (pricedProviderModelKeys.has(key)) {
        hostedPricing.delete(key);
        continue;
      }
      const pricing = mergePricing(entry.openRouter, entry.liteLLM);
      if (pricing) {
        hostedPricing.set(key, pricing);
      } else {
        hostedPricing.delete(key);
      }
    }
  }
}

function readPricingPolicies(manifests) {
  const policies = new Map();
  for (const entry of manifests) {
    for (const [providerId, policy] of Object.entries(
      entry.manifest?.modelPricing?.providers ?? {},
    )) {
      policies.set(providerId, policy);
    }
  }
  return policies;
}

async function readJsonResponse(response, source) {
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
  const chunks = [];
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
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${source} response is malformed JSON`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${source} response is not a JSON object`);
  }
  return payload;
}

async function fetchPricingSources(fetchImpl) {
  const signal = AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS);
  const results = await Promise.allSettled([
    fetchImpl(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal,
    }).then((response) => readJsonResponse(response, "OpenRouter")),
    fetchImpl(LITELLM_PRICING_URL, {
      headers: { Accept: "application/json" },
      signal,
    }).then((response) => readJsonResponse(response, "LiteLLM")),
  ]);
  const [openRouterResult, liteLlmResult] = results;
  for (const { label, result } of [
    { label: "OpenRouter", result: openRouterResult },
    { label: "LiteLLM", result: liteLlmResult },
  ]) {
    if (result.status === "rejected") {
      process.stderr.write(
        `[${SCRIPT_LABEL}] warning: ${label} pricing unavailable: ${String(result.reason)}\n`,
      );
    }
  }
  return {
    openRouter: openRouterResult.status === "fulfilled" ? openRouterResult.value : {},
    liteLlm: liteLlmResult.status === "fulfilled" ? liteLlmResult.value : {},
  };
}

export async function enrichModelCatalogPricing(options) {
  const policies = readPricingPolicies(options.manifests);
  const sources = await fetchPricingSources(options.fetchImpl ?? fetch);
  const openRouterCatalog = new Map();
  for (const row of Array.isArray(sources.openRouter.data) ? sources.openRouter.data : []) {
    const pricing = parseOpenRouterPricing(row?.pricing);
    if (typeof row?.id === "string" && pricing) {
      openRouterCatalog.set(row.id, pricing);
    }
  }
  const liteLlmCatalog = new Map();
  const liteLlmAliasGroups = [];
  for (const [id, row] of Object.entries(sources.liteLlm)) {
    const pricing = parseLiteLLMPricing(row);
    if (pricing) {
      const aliases = [id];
      if (typeof row?.litellm_provider === "string" && !id.includes("/")) {
        aliases.push(`${row.litellm_provider}/${id}`);
      }
      for (const alias of aliases) {
        liteLlmCatalog.set(alias, pricing);
      }
      liteLlmAliasGroups.push(aliases);
    }
  }

  let enriched = 0;
  const coveredPricingKeys = new Set();
  const pricedProviderModelKeys = new Set();
  for (const [providerId, provider] of Object.entries(options.bundle.providers)) {
    for (const model of provider.models) {
      const openRouterCandidates = buildPricingCandidates({
        providerId,
        modelId: model.id,
        source: "openRouter",
        policies,
      });
      const openRouterPricing = openRouterCandidates
        .map((candidate) => openRouterCatalog.get(candidate))
        .find(Boolean);
      const liteLlmCandidates = buildPricingCandidates({
        providerId,
        modelId: model.id,
        source: "liteLLM",
        policies,
      });
      const liteLlmPricing = liteLlmCandidates
        .map((candidate) => liteLlmCatalog.get(candidate))
        .find(Boolean);
      const cost = mergePricing(openRouterPricing, liteLlmPricing);
      if (cost && hasKnownPricing(cost)) {
        model.cost = cost;
        enriched += 1;
      }
      if (model.cost && hasKnownPricing(model.cost)) {
        const providerModelKey = `${providerId}/${model.id}`;
        coveredPricingKeys.add(providerModelKey);
        pricedProviderModelKeys.add(providerModelKey);
        for (const candidate of [...openRouterCandidates, ...liteLlmCandidates]) {
          coveredPricingKeys.add(candidate);
        }
      }
    }
  }

  const hostedPricing = new Map();
  for (const [key, pricing] of openRouterCatalog) {
    hostedPricing.set(key, pricing);
  }
  for (const [key, pricing] of liteLlmCatalog) {
    hostedPricing.set(key, mergePricing(hostedPricing.get(key), pricing));
  }
  for (const aliases of liteLlmAliasGroups) {
    if (aliases.some((alias) => coveredPricingKeys.has(alias))) {
      for (const alias of aliases) {
        coveredPricingKeys.add(alias);
      }
    }
  }
  for (const key of coveredPricingKeys) {
    hostedPricing.delete(key);
  }
  materializePolicyRuntimePricing({
    hostedPricing,
    policies,
    openRouterCatalog,
    liteLlmCatalog,
    pricedProviderModelKeys,
  });
  options.bundle.pricing = Object.fromEntries(
    [...hostedPricing.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, pricing]) => [key, compactPricing(pricing)]),
  );
  const validateBundle = options.validateBundle ?? (await loadClientBundleValidator());
  const validated = validateBundle(options.bundle);
  options.bundle.providers = validated.providers;
  options.bundle.pricing = validated.pricing;
  return { modelsEnriched: enriched, pricingEntries: hostedPricing.size };
}

function sortCatalogValue(value) {
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

export function serializeModelCatalogBundle(bundle) {
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

function resolveSourceCommit(rootDir) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

async function runPublishModelCatalog(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const args = parsePublishModelCatalogArgs(options.args ?? process.argv.slice(2));
  const generatedAt = (options.now ?? Date.now)();
  const sourceCommit = options.sourceCommit ?? resolveSourceCommit(rootDir);
  const manifests = readModelCatalogManifests({ rootDir });
  const bundle = await assembleModelCatalogBundle({
    manifests,
    generatedAt,
    sourceCommit,
  });
  const pricingResult = args.pricing
    ? await enrichModelCatalogPricing({ bundle, manifests, fetchImpl: options.fetchImpl })
    : { modelsEnriched: 0, pricingEntries: 0 };
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
  const stats = `schemaVersion=1 providers=${summary.providers} models=${summary.models} costModels=${summary.costModels} pricingEnriched=${pricingResult.modelsEnriched} pricingEntries=${pricingResult.pricingEntries} bundleBytes=${bundleBytes} generatedAt=${bundle.generatedAt} minVersion=${bundle.minVersion} sourceCommit=${bundle.sourceCommit}`;
  if (args.dryRun) {
    process.stdout.write(`[${SCRIPT_LABEL}] dry-run ${stats}\n`);
    return { bundle, summary, pricingEnriched: pricingResult.modelsEnriched, wrote: false };
  }

  const outputFile = path.resolve(rootDir, args.out);
  if (args.out) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, serialized);
  }
  process.stdout.write(`[${SCRIPT_LABEL}] published ${stats} out=${args.out}\n`);
  return { bundle, summary, pricingEnriched: pricingResult.modelsEnriched, wrote: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runPublishModelCatalog();
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`[${SCRIPT_LABEL}] FAILED (exit ${exitCode})\n`);
    process.exitCode = exitCode;
  }
}
