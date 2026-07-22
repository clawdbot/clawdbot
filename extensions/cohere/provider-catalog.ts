import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildCohereCatalogModels, COHERE_BASE_URL } from "./models.js";

export const COHERE_LIVE_MODEL_DISCOVERY: OpenAICompatibleModelDiscoveryOptions = {
  endpointUrl: {
    url: "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000",
    requireBaseUrl: COHERE_BASE_URL,
  },
  readRows: (body) => {
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { models?: unknown }).models)
    ) {
      throw new Error("Cohere model catalog response must contain models[]");
    }
    return (body as { models: unknown[] }).models.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return [];
      }
      const record = row as Record<string, unknown>;
      const modelId = typeof record.name === "string" ? record.name.trim() : "";
      return modelId ? [{ ...record, id: modelId, active: record.is_deprecated !== true }] : [];
    });
  },
};

export function buildCohereProvider(): ModelProviderConfig {
  return {
    baseUrl: COHERE_BASE_URL,
    api: "openai-completions",
    models: buildCohereCatalogModels(),
  };
}
