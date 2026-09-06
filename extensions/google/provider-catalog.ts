import {
  buildLiveModelProviderConfig,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { isGoogleTextGenerationModelId, resolveGoogleStaticModelId } from "./provider-models.js";

const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_GEMINI_MODELS_CACHE_TTL_MS = 60_000;
const GOOGLE_GEMINI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "google",
  catalog: manifest.modelCatalog.providers.google,
});
const GOOGLE_GEMINI_MODELS_ENDPOINT = `${GOOGLE_GEMINI_MANIFEST_PROVIDER.baseUrl}/models?pageSize=1000`;
const GOOGLE_GEMINI_TEXT_MODELS = GOOGLE_GEMINI_MANIFEST_PROVIDER.models;
const GOOGLE_GEMINI_TEXT_MODEL_BY_ID = new Map(
  GOOGLE_GEMINI_TEXT_MODELS.map((model) => [model.id, model]),
);
const GOOGLE_GEMINI_TEXT_MODEL_IDS: ReadonlySet<string> = new Set(
  GOOGLE_GEMINI_TEXT_MODEL_BY_ID.keys(),
);

function requireGoogleManifestCost(): NonNullable<ModelDefinitionConfig["cost"]> {
  const cost = GOOGLE_GEMINI_TEXT_MODELS[0]?.cost;
  if (!cost) {
    throw new Error("Google manifest model catalog must declare a cost for its first model");
  }
  return cost;
}

const GOOGLE_GEMINI_COST = requireGoogleManifestCost();

export function buildGoogleStaticCatalogProvider(): ModelProviderConfig {
  return {
    ...GOOGLE_GEMINI_MANIFEST_PROVIDER,
    models: GOOGLE_GEMINI_TEXT_MODELS.map((model) => ({
      ...model,
      input: [...model.input, "video"],
    })),
  };
}

function readGoogleLiveModels(body: unknown): readonly unknown[] {
  const record = asOptionalRecord(body);
  if (!record || (record.models !== undefined && !Array.isArray(record.models))) {
    throw new Error("Google models.list returned an invalid model list");
  }
  return record.models ?? [];
}

function googleLiveModelInput(id: string): ModelDefinitionConfig["input"] {
  if (!id.startsWith("gemma-")) {
    return ["text", "image", "video"];
  }
  const isMultimodalGemma =
    /^gemma-3-(?:4b|12b|27b)(?:-|$)/.test(id) ||
    id.startsWith("gemma-3n-") ||
    id.startsWith("gemma-4-");
  return isMultimodalGemma ? ["text", "image"] : ["text"];
}

function buildGoogleLiveModel(row: unknown): ModelDefinitionConfig | undefined {
  const record = asOptionalRecord(row);
  if (!record) {
    throw new Error("Google models.list returned an invalid model row");
  }
  const resourceName = normalizeOptionalString(record.name);
  const id = resourceName?.startsWith("models/") ? resourceName.slice("models/".length) : undefined;
  const methods = record.supportedGenerationMethods;
  const contextWindow = asPositiveSafeInteger(record.inputTokenLimit);
  const maxTokens = asPositiveSafeInteger(record.outputTokenLimit);
  if (
    !id ||
    !isGoogleTextGenerationModelId(id) ||
    !Array.isArray(methods) ||
    !methods.includes("generateContent") ||
    !contextWindow ||
    !maxTokens
  ) {
    return undefined;
  }
  // Compat flags apply to evaluated weights only. Resolve discovered id
  // variants (aliases, dated previews, -latest) to the bundled entry with the
  // same weights; ids that do not resolve keep no compat (fail closed).
  const staticId = resolveGoogleStaticModelId(id, GOOGLE_GEMINI_TEXT_MODEL_IDS);
  const staticModel = staticId ? GOOGLE_GEMINI_TEXT_MODEL_BY_ID.get(staticId) : undefined;
  return {
    id,
    name: normalizeOptionalString(record.displayName) ?? id,
    reasoning: record.thinking === true,
    // models.list omits modalities. Gemma has both text-only small variants and
    // multimodal families, so keep this capability distinction explicit.
    input: googleLiveModelInput(id),
    cost: GOOGLE_GEMINI_COST,
    contextWindow,
    maxTokens,
    ...(staticModel?.compat ? { compat: { ...staticModel.compat } } : {}),
    ...(staticModel?.thinkingLevelMap
      ? { thinkingLevelMap: { ...staticModel.thinkingLevelMap } }
      : {}),
  };
}

function parseGoogleLiveModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const models = rows
    .map(buildGoogleLiveModel)
    .filter((model): model is ModelDefinitionConfig => Boolean(model));
  return [...new Map(models.map((model) => [model.id, model])).values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
}

export async function buildGoogleLiveCatalogProvider(params: {
  discoveryMode?: "strict";
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const { models, ...providerConfig } = buildGoogleStaticCatalogProvider();
  return await buildLiveModelProviderConfig({
    providerId: "google",
    endpoint: GOOGLE_GEMINI_MODELS_ENDPOINT,
    providerConfig,
    models,
    ...params,
    ttlMs: GOOGLE_GEMINI_MODELS_CACHE_TTL_MS,
    auditContext: "google-model-discovery",
    readRows: readGoogleLiveModels,
    buildRequestHeaders: ({ discoveryApiKey, apiKey }) => ({
      Accept: "application/json",
      ...((discoveryApiKey ?? apiKey) ? { "x-goog-api-key": discoveryApiKey ?? apiKey } : {}),
    }),
    projectRows: parseGoogleLiveModels,
  });
}

export function buildGoogleVertexStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_VERTEX_BASE_URL,
    api: "google-vertex",
    models: GOOGLE_GEMINI_TEXT_MODELS,
  };
}
