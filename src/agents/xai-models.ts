import type { ModelDefinitionConfig } from "../config/types.js";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL_ID = "grok-3-beta";
export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

// xAI pricing varies by model; set to 0 as placeholder
export const XAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of xAI (Grok) models.
 *
 * This catalog serves as a fallback when the xAI API is unreachable
 * or when no API key is configured. xAI's /v1/models endpoint requires
 * authentication, unlike some other providers.
 *
 * Models organized by series, newest first.
 */
export const XAI_MODEL_CATALOG = [
  // Grok 4.1 Series (latest)
  {
    id: "grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 2000000,
    maxTokens: 16384,
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 2000000,
    maxTokens: 16384,
  },

  // Grok 4 Series
  {
    id: "grok-4-07-09",
    name: "Grok 4",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 16384,
  },
  {
    id: "grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 2000000,
    maxTokens: 16384,
  },
  {
    id: "grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 2000000,
    maxTokens: 16384,
  },

  // Grok 3 Series
  {
    id: "grok-3-beta",
    name: "Grok 3",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "grok-3-mini-beta",
    name: "Grok 3 Mini",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
  },

  // Grok 2 Series
  {
    id: "grok-2-1212",
    name: "Grok 2",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: "grok-2-vision-1212",
    name: "Grok 2 Vision",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 32768,
    maxTokens: 8192,
  },

  // Specialized
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 256000,
    maxTokens: 16384,
  },
] as const;

export type XaiCatalogEntry = (typeof XAI_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from an xAI catalog entry.
 */
export function buildXaiModelDefinition(entry: XaiCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: XAI_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// xAI API response types (OpenAI-compatible format)
interface XaiModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface XaiModelsResponse {
  object: "list";
  data: XaiModel[];
}

/**
 * Discover models from xAI API with fallback to static catalog.
 *
 * Unlike Venice, xAI's /v1/models endpoint requires authentication,
 * so discovery only works when an API key is provided.
 */
export async function discoverXaiModels(apiKey: string): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return XAI_MODEL_CATALOG.map(buildXaiModelDefinition);
  }

  try {
    const response = await fetch(`${XAI_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[xai-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return XAI_MODEL_CATALOG.map(buildXaiModelDefinition);
    }

    const data = (await response.json()) as XaiModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[xai-models] No models found from API, using static catalog");
      return XAI_MODEL_CATALOG.map(buildXaiModelDefinition);
    }

    // Merge discovered models with catalog metadata
    const catalogById = new Map<string, XaiCatalogEntry>(XAI_MODEL_CATALOG.map((m) => [m.id, m]));
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of data.data) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        // Use catalog metadata for known models
        models.push(buildXaiModelDefinition(catalogEntry));
      } else {
        // Create definition for newly discovered models not in catalog
        const idLower = apiModel.id.toLowerCase();
        const isReasoning =
          idLower.includes("reasoning") || idLower.includes("think") || idLower.includes("r1");

        const hasVision = idLower.includes("vision");

        models.push({
          id: apiModel.id,
          name: apiModel.id, // xAI API only returns id, not display names
          reasoning: isReasoning,
          input: hasVision ? ["text", "image"] : ["text"],
          cost: XAI_DEFAULT_COST,
          contextWindow: 131072, // Conservative default
          maxTokens: 8192,
        });
      }
    }

    return models.length > 0 ? models : XAI_MODEL_CATALOG.map(buildXaiModelDefinition);
  } catch (error) {
    console.warn(`[xai-models] Discovery failed: ${String(error)}, using static catalog`);
    return XAI_MODEL_CATALOG.map(buildXaiModelDefinition);
  }
}
