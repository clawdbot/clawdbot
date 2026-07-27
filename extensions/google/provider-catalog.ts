// Google provider module implements model/runtime integration.
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { isGoogleTextGenerationModelId } from "./provider-models.js";

const GOOGLE_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_GEMINI_MODELS_ENDPOINT = `${GOOGLE_GEMINI_BASE_URL}/models?pageSize=1000`;
const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_GEMINI_MODELS_CACHE_TTL_MS = 60_000;
const GOOGLE_GEMINI_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const GOOGLE_GEMINI_TEXT_MODELS: ModelDefinitionConfig[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash-Lite",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
];

export function buildGoogleStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_GEMINI_BASE_URL,
    api: "google-generative-ai",
    models: GOOGLE_GEMINI_TEXT_MODELS,
  };
}

function readGoogleLiveModels(body: unknown): readonly unknown[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const models = (body as { models?: unknown }).models;
  return Array.isArray(models) ? models : [];
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function googleLiveModelInput(id: string): ModelDefinitionConfig["input"] {
  if (!id.startsWith("gemma-")) {
    return ["text", "image"];
  }
  const isMultimodalGemma =
    /^gemma-3-(?:4b|12b|27b)(?:-|$)/.test(id) ||
    id.startsWith("gemma-3n-") ||
    id.startsWith("gemma-4-");
  return isMultimodalGemma ? ["text", "image"] : ["text"];
}

function buildGoogleLiveModel(row: unknown): ModelDefinitionConfig | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const resourceName = readString(record, "name");
  const id = resourceName?.startsWith("models/") ? resourceName.slice("models/".length) : undefined;
  const methods = record.supportedGenerationMethods;
  const contextWindow = readPositiveInteger(record, "inputTokenLimit");
  const maxTokens = readPositiveInteger(record, "outputTokenLimit");
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
  return {
    id,
    name: readString(record, "displayName") ?? id,
    reasoning: record.thinking === true,
    // models.list omits modalities. Gemma has both text-only small variants and
    // multimodal families, so keep this capability distinction explicit.
    input: googleLiveModelInput(id),
    cost: GOOGLE_GEMINI_COST,
    contextWindow,
    maxTokens,
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
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const fallback = {
    ...buildGoogleStaticCatalogProvider(),
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
  };
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: "google",
      endpoint: GOOGLE_GEMINI_MODELS_ENDPOINT,
      apiKey: params.apiKey,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      ttlMs: GOOGLE_GEMINI_MODELS_CACHE_TTL_MS,
      auditContext: "google-model-discovery",
      readRows: readGoogleLiveModels,
      buildRequestHeaders: ({ discoveryApiKey, apiKey }) => ({
        Accept: "application/json",
        ...((discoveryApiKey ?? apiKey) ? { "x-goog-api-key": discoveryApiKey ?? apiKey } : {}),
      }),
      shouldCacheRows: (modelRows) => parseGoogleLiveModels(modelRows).length > 0,
    });
    const models = parseGoogleLiveModels(rows);
    if (models.length === 0) {
      return fallback;
    }
    return {
      ...fallback,
      models,
    };
  } catch {
    // Discovery is advisory. Offline setup, expired credentials, and transient
    // provider failures retain the bundled catalog instead of hiding Google.
    return fallback;
  }
}

export function buildGoogleVertexStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_VERTEX_BASE_URL,
    api: "google-vertex",
    models: GOOGLE_GEMINI_TEXT_MODELS,
  };
}
