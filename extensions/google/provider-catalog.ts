import {
  buildLiveModelProviderConfig,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isGoogleTextGenerationModelId, resolveGoogleStaticModelId } from "./provider-models.js";

const GOOGLE_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_GEMINI_MODELS_ENDPOINT = `${GOOGLE_GEMINI_BASE_URL}/models?pageSize=1000`;
const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_GEMINI_MODELS_CACHE_TTL_MS = 60_000;
const GOOGLE_GEMINI_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const GOOGLE_GEMINI_TEXT_MODEL_ROWS: ReadonlyArray<
  readonly [
    id: string,
    name: string,
    prefersCodeMode: boolean,
    thinkingLevelMap?: ModelDefinitionConfig["thinkingLevelMap"],
  ]
> = [
  ["gemini-2.5-pro", "Gemini 2.5 Pro", false],
  ["gemini-2.5-flash", "Gemini 2.5 Flash", false],
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", false],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", true],
  ["gemini-3.6-flash", "Gemini 3.6 Flash", true],
  ["gemini-3.7-flash", "Gemini 3.7 Flash", true, { minimal: null }],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", true],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", true],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", true],
  ["gemini-3-flash-preview", "Gemini 3 Flash Preview", true],
];
const GOOGLE_GEMINI_TEXT_MODELS: ModelDefinitionConfig[] = GOOGLE_GEMINI_TEXT_MODEL_ROWS.map(
  ([id, name, prefersCodeMode, thinkingLevelMap]): ModelDefinitionConfig => {
    const model: ModelDefinitionConfig = {
      id,
      name,
      reasoning: true,
      input: ["text", "image"],
      cost: GOOGLE_GEMINI_COST,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    };
    if (thinkingLevelMap) {
      model.thinkingLevelMap = thinkingLevelMap;
    }
    if (prefersCodeMode) {
      model.compat = { codeMode: "preferred" };
    }
    return model;
  },
);
const GOOGLE_GEMINI_TEXT_MODEL_BY_ID = new Map(
  GOOGLE_GEMINI_TEXT_MODELS.map((model) => [model.id, model]),
);
const GOOGLE_GEMINI_TEXT_MODEL_IDS: ReadonlySet<string> = new Set(
  GOOGLE_GEMINI_TEXT_MODEL_BY_ID.keys(),
);

export function buildGoogleStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_GEMINI_BASE_URL,
    api: "google-generative-ai",
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
