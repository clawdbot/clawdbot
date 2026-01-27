import type { ModelDefinitionConfig } from "../config/types.js";

export const OVHCLOUD_BASE_URL = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";
export const OVHCLOUD_DEFAULT_MODEL_ID = "gpt-oss-120b";
export const OVHCLOUD_DEFAULT_MODEL_REF = `ovhcloud/${OVHCLOUD_DEFAULT_MODEL_ID}`;
export const OVHCLOUD_DEFAULT_CONTEXT_WINDOW = 128000;
export const OVHCLOUD_DEFAULT_MAX_TOKENS = 8192;
export const OVHCLOUD_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// OVHcloud Catalog API response types
interface OvhcloudModelPricing {
  prompt: string;
  completion: string;
  input_cache_reads: string;
  input_cache_writes: string;
  image: string;
  request: string;
}

interface OvhcloudModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  max_output_length: number;
  input_modalities: string[];
  output_modalities: string[];
  supported_features: string[];
  pricing: OvhcloudModelPricing;
  hugging_face_id?: string;
  openrouter?: {
    slug: string;
  };
  quantization?: string;
  created?: number;
  datacenters?: Array<{ country_code: string }>;
}

interface OvhcloudCatalogResponse {
  data: OvhcloudModel[];
}

const OVHCLOUD_CATALOG_URL = "https://catalog.endpoints.ai.ovh.net/rest/v2/openrouter";

/**
 * Discover models from OVHcloud AI Endpoints catalog with fallback to default model.
 * The catalog endpoint is public and does not require authentication.
 */
export async function discoverOvhcloudModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [
      {
        id: OVHCLOUD_DEFAULT_MODEL_ID,
        name: OVHCLOUD_DEFAULT_MODEL_ID,
        reasoning: false,
        input: ["text"],
        cost: OVHCLOUD_DEFAULT_COST,
        contextWindow: OVHCLOUD_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OVHCLOUD_DEFAULT_MAX_TOKENS,
      },
    ];
  }

  try {
    const response = await fetch(OVHCLOUD_CATALOG_URL, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[ovhcloud-models] Failed to discover models: HTTP ${response.status}, using default model`,
      );
      return [
        {
          id: OVHCLOUD_DEFAULT_MODEL_ID,
          name: OVHCLOUD_DEFAULT_MODEL_ID,
          reasoning: false,
          input: ["text"],
          cost: OVHCLOUD_DEFAULT_COST,
          contextWindow: OVHCLOUD_DEFAULT_CONTEXT_WINDOW,
          maxTokens: OVHCLOUD_DEFAULT_MAX_TOKENS,
        },
      ];
    }

    const data = (await response.json()) as OvhcloudCatalogResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[ovhcloud-models] No models found from catalog, using default model");
      return [
        {
          id: OVHCLOUD_DEFAULT_MODEL_ID,
          name: OVHCLOUD_DEFAULT_MODEL_ID,
          reasoning: false,
          input: ["text"],
          cost: OVHCLOUD_DEFAULT_COST,
          contextWindow: OVHCLOUD_DEFAULT_CONTEXT_WINDOW,
          maxTokens: OVHCLOUD_DEFAULT_MAX_TOKENS,
        },
      ];
    }

    // Convert discovered models to ModelDefinitionConfig
    const models: ModelDefinitionConfig[] = data.data.map((apiModel) => {
      const isReasoning = apiModel.supported_features?.includes("reasoning") ?? false;
      const hasVision = apiModel.input_modalities?.includes("image") ?? false;

      // Parse pricing (values are strings representing cost per token, convert to cost per million tokens)
      // Example: "0.00000009" per token = 0.09 per million tokens
      const parsePricing = (value: string): number => {
        if (!value || value === "") return 0;
        const num = parseFloat(value);
        if (isNaN(num) || num === 0) return 0;
        // Convert per-token to per-million-tokens, round to nearest integer
        // For very small values (< 0.5 per million), use Math.ceil to avoid rounding to 0
        const perMillion = num * 1000000;
        return perMillion < 0.5 ? Math.ceil(perMillion) : Math.round(perMillion);
      };

      const cost = {
        input: parsePricing(apiModel.pricing.prompt),
        output: parsePricing(apiModel.pricing.completion),
        cacheRead: parsePricing(apiModel.pricing.input_cache_reads),
        cacheWrite: parsePricing(apiModel.pricing.input_cache_writes),
      };

      return {
        id: apiModel.id,
        name: apiModel.name || apiModel.id,
        reasoning: isReasoning,
        input: hasVision ? ["text", "image"] : ["text"],
        cost,
        contextWindow: apiModel.context_length || OVHCLOUD_DEFAULT_CONTEXT_WINDOW,
        maxTokens: apiModel.max_output_length || OVHCLOUD_DEFAULT_MAX_TOKENS,
      };
    });

    return models.length > 0
      ? models
      : [
          {
            id: OVHCLOUD_DEFAULT_MODEL_ID,
            name: OVHCLOUD_DEFAULT_MODEL_ID,
            reasoning: false,
            input: ["text"],
            cost: OVHCLOUD_DEFAULT_COST,
            contextWindow: OVHCLOUD_DEFAULT_CONTEXT_WINDOW,
            maxTokens: OVHCLOUD_DEFAULT_MAX_TOKENS,
          },
        ];
  } catch (error) {
    console.warn(`[ovhcloud-models] Discovery failed: ${String(error)}, using default model`);
    return [
      {
        id: OVHCLOUD_DEFAULT_MODEL_ID,
        name: OVHCLOUD_DEFAULT_MODEL_ID,
        reasoning: false,
        input: ["text"],
        cost: OVHCLOUD_DEFAULT_COST,
        contextWindow: OVHCLOUD_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OVHCLOUD_DEFAULT_MAX_TOKENS,
      },
    ];
  }
}
