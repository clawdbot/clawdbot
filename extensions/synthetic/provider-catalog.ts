// Synthetic provider module implements model/runtime integration.
import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  filterStringEntries,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_MODEL_CATALOG,
} from "./models.js";

export function buildSyntheticProvider(): ModelProviderConfig {
  return {
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  };
}

function readTokenPrice(value: unknown): number | undefined {
  const raw = normalizeOptionalString(value)?.replace(/^\$/, "");
  const price = raw ? Number(raw) * 1_000_000 : Number.NaN;
  return Number.isFinite(price) && price >= 0 ? Number(price.toFixed(9)) : undefined;
}

function projectSyntheticModels(
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
): ModelDefinitionConfig[] {
  const seeds = new Map(fallback.models.map((model) => [model.id, model]));
  const models = new Map<string, ModelDefinitionConfig>();
  for (const row of rows) {
    const record = asOptionalRecord(row);
    const id = normalizeOptionalString(record?.id);
    const contextWindow = asPositiveSafeInteger(record?.context_length);
    const input = filterStringEntries(record?.input_modalities);
    if (
      !record ||
      !id ||
      id.length > 512 ||
      /[\s\p{Cc}]/u.test(id) ||
      !contextWindow ||
      !input.includes("text") ||
      !filterStringEntries(record.output_modalities).includes("text") ||
      record.deprecated === true ||
      record.active === false
    ) {
      continue;
    }
    const seed = seeds.get(id);
    const features = filterStringEntries(record.supported_features);
    const efforts = filterStringEntries(asOptionalRecord(record.reasoning_parameters)?.efforts);
    const pricing = asOptionalRecord(record.pricing);
    // The live feed owns current limits and capabilities even for seeded IDs.
    // ProxiedModelDetails may omit output limits and supported_features.
    models.set(id, {
      ...seed,
      id,
      name: normalizeOptionalString(record.name) ?? id,
      reasoning: features.includes("reasoning") || efforts.some((effort) => effort !== "none"),
      input: input.includes("image") ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens: Math.min(
        asPositiveSafeInteger(record.max_output_length) ?? seed?.maxTokens ?? 8192,
        contextWindow,
      ),
      cost: {
        input: readTokenPrice(pricing?.prompt) ?? seed?.cost.input ?? 0,
        output: readTokenPrice(pricing?.completion) ?? seed?.cost.output ?? 0,
        cacheRead: readTokenPrice(pricing?.input_cache_reads) ?? seed?.cost.cacheRead ?? 0,
        cacheWrite: readTokenPrice(pricing?.input_cache_writes) ?? seed?.cost.cacheWrite ?? 0,
      },
      ...(Array.isArray(record.supported_features)
        ? { compat: { ...seed?.compat, supportsTools: features.includes("tools") } }
        : {}),
    });
  }
  return [...models.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

export const SYNTHETIC_MODEL_DISCOVERY: OpenAICompatibleModelDiscoveryOptions = {
  // Discovery is OpenAI-compatible; inference stays on the Anthropic endpoint.
  // A custom proxy's credential must never be forwarded to this vendor URL.
  endpointUrl: {
    url: "https://api.synthetic.new/openai/v1/models",
    requireBaseUrl: SYNTHETIC_BASE_URL,
  },
  projectRows: projectSyntheticModels,
};
