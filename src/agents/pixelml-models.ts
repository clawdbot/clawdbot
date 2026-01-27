import type { ModelDefinitionConfig } from "../config/types.js";

export const PIXELML_BASE_URL = "https://ishi.pixelml.com/v1";
export const PIXELML_DEFAULT_MODEL_ID = "gpt-4o-mini";
export const PIXELML_DEFAULT_MODEL_REF = `pixelml/${PIXELML_DEFAULT_MODEL_ID}`;

// PixelML uses a unified pricing model; set to 0 as costs vary by model.
export const PIXELML_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Static catalog of PixelML models.
 * PixelML provides a unified OpenAI-compatible API for multiple AI models.
 *
 * This catalog serves as a fallback when the PixelML API is unreachable.
 */
export const PIXELML_MODEL_CATALOG = [
  // GPT models
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
  },
  // Claude models
  {
    id: "claude-4.5-haiku",
    name: "Claude 4.5 Haiku",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "claude-4.5-sonnet",
    name: "Claude 4.5 Sonnet",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
  },
] as const;

export type PixelmlCatalogEntry = (typeof PIXELML_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from a PixelML catalog entry.
 */
export function buildPixelmlModelDefinition(entry: PixelmlCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: PIXELML_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// PixelML API response types
interface PixelmlModelCost {
  input: number;
  output: number;
}

interface PixelmlModelLimit {
  context: number;
  output: number;
}

interface PixelmlModelModalities {
  input: Array<"text" | "image">;
  output: Array<"text" | "image">;
}

interface PixelmlModel {
  id: string;
  name: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  cost?: PixelmlModelCost;
  limit?: PixelmlModelLimit;
  modalities?: PixelmlModelModalities;
  options?: Record<string, unknown>;
}

// Response can be either { data: [...] } or a flat array
type PixelmlModelsResponse = { data: PixelmlModel[] } | PixelmlModel[];

/**
 * Discover models from PixelML API with fallback to static catalog.
 * The /models endpoint requires authentication.
 */
export async function discoverPixelmlModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return PIXELML_MODEL_CATALOG.map(buildPixelmlModelDefinition);
  }

  // Without an API key, return the static catalog
  if (!apiKey?.trim()) {
    return PIXELML_MODEL_CATALOG.map(buildPixelmlModelDefinition);
  }

  try {
    const response = await fetch(`${PIXELML_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[pixelml-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return PIXELML_MODEL_CATALOG.map(buildPixelmlModelDefinition);
    }

    const rawData = (await response.json()) as PixelmlModelsResponse;
    // Handle both { data: [...] } and flat array responses
    const apiModels = Array.isArray(rawData) ? rawData : rawData.data;
    if (!Array.isArray(apiModels) || apiModels.length === 0) {
      console.warn("[pixelml-models] No models found from API, using static catalog");
      return PIXELML_MODEL_CATALOG.map(buildPixelmlModelDefinition);
    }

    // Build models from API response
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of apiModels) {
      // Extract model ID without provider prefix (e.g., "pixelml/gpt-5.1" -> "gpt-5.1")
      const modelId = apiModel.id.includes("/")
        ? apiModel.id.split("/").slice(1).join("/")
        : apiModel.id;

      // Use API-provided modalities, filtering to only supported types (text, image)
      const rawModalities = apiModel.modalities?.input ?? ["text"];
      const inputModalities: Array<"text" | "image"> = rawModalities.filter(
        (m): m is "text" | "image" => m === "text" || m === "image",
      );
      // Ensure at least "text" is present
      if (inputModalities.length === 0) {
        inputModalities.push("text");
      }

      // Use API-provided values with sensible defaults
      models.push({
        id: modelId,
        name: apiModel.name || modelId,
        reasoning: apiModel.reasoning ?? false,
        input: inputModalities,
        cost: {
          input: apiModel.cost?.input ?? 0,
          output: apiModel.cost?.output ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: apiModel.limit?.context ?? 128000,
        maxTokens: apiModel.limit?.output ?? 8192,
      });
    }

    return models.length > 0 ? models : PIXELML_MODEL_CATALOG.map(buildPixelmlModelDefinition);
  } catch (error) {
    console.warn(`[pixelml-models] Discovery failed: ${String(error)}, using static catalog`);
    return PIXELML_MODEL_CATALOG.map(buildPixelmlModelDefinition);
  }
}
