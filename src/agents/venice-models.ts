import type { ModelDefinitionConfig } from "../config/types.js";

export const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
export const VENICE_DEFAULT_MODEL_ID = "llama-3.3-70b";
export const VENICE_DEFAULT_MODEL_REF = `venice/${VENICE_DEFAULT_MODEL_ID}`;

// Venice uses credit-based pricing, not per-token costs.
// Set to 0 as costs vary by model and account type.
export const VENICE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of Venice AI models.
 *
 * Venice provides two privacy modes:
 * - "private": Fully private inference, no logging, ephemeral
 * - "anonymized": Proxied through Venice with metadata stripped (for proprietary models)
 *
 * Note: The `privacy` field is included for documentation purposes but is not
 * propagated to ModelDefinitionConfig as it's not part of the core model schema.
 * Privacy mode is determined by the model itself, not configurable at runtime.
 *
 * This catalog serves as a fallback when the Venice API is unreachable.
 */
export const VENICE_MODEL_CATALOG = [
  // ============================================
  // PRIVATE MODELS (Fully private, no logging)
  // ============================================

  // Llama models
  {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "llama-3.2-3b",
    name: "Llama 3.2 3B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "hermes-3-llama-3.1-405b",
    name: "Hermes 3 Llama 3.1 405B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },

  // Qwen models
  {
    id: "qwen3-235b-a22b-thinking-2507",
    name: "Qwen3 235B Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "qwen3-235b-a22b-instruct-2507",
    name: "Qwen3 235B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "qwen3-next-80b",
    name: "Qwen3 Next 80B",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "qwen3-vl-235b-a22b",
    name: "Qwen3 VL 235B (Vision)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "qwen3-4b",
    name: "Venice Small (Qwen3 4B)",
    reasoning: true,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    privacy: "private",
  },

  // DeepSeek
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: true,
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 8192,
    privacy: "private",
  },

  // Venice-specific models
  {
    id: "venice-uncensored",
    name: "Venice Uncensored (Dolphin-Mistral)",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "mistral-31-24b",
    name: "Venice Medium (Mistral)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },

  // Other private models
  {
    id: "google-gemma-3-27b-it",
    name: "Google Gemma 3 27B Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 202752,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "openai-gpt-oss-120b",
    name: "OpenAI GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "zai-org-glm-4.7",
    name: "GLM 4.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 8192,
    privacy: "private",
  },

  // ============================================
  // ANONYMIZED MODELS (Proxied through Venice)
  // These are proprietary models accessed via Venice's proxy
  // ============================================

  // Anthropic (via Venice)
  {
    id: "claude-opus-45",
    name: "Claude Opus 4.5 (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 202752,
    maxTokens: 8192,
    privacy: "anonymized",
  },
  {
    id: "claude-sonnet-45",
    name: "Claude Sonnet 4.5 (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 202752,
    maxTokens: 8192,
    privacy: "anonymized",
  },

  // OpenAI (via Venice)
  {
    id: "openai-gpt-52",
    name: "GPT-5.2 (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-52-codex",
    name: "GPT-5.2 Codex (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "anonymized",
  },

  // Google (via Venice)
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 202752,
    maxTokens: 8192,
    privacy: "anonymized",
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "anonymized",
  },

  // xAI (via Venice)
  {
    id: "grok-41-fast",
    name: "Grok 4.1 Fast (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "anonymized",
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1 (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "anonymized",
  },

  // Other anonymized models
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    privacy: "anonymized",
  },
  {
    id: "minimax-m21",
    name: "MiniMax M2.1 (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 8192,
    privacy: "anonymized",
  },
] as const;

export type VeniceCatalogEntry = (typeof VENICE_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from a Venice catalog entry.
 *
 * Note: The `privacy` field from the catalog is not included in the output
 * as ModelDefinitionConfig doesn't support custom metadata fields. Privacy
 * mode is inherent to each model and documented in the catalog/docs.
 */
export function buildVeniceModelDefinition(entry: VeniceCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: VENICE_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// Venice API response types
interface VeniceModelSpec {
  name: string;
  privacy: "private" | "anonymized";
  availableContextTokens: number;
  capabilities: {
    supportsReasoning: boolean;
    supportsVision: boolean;
    supportsFunctionCalling: boolean;
  };
}

interface VeniceModel {
  id: string;
  model_spec: VeniceModelSpec;
}

interface VeniceModelsResponse {
  data: VeniceModel[];
}

/**
 * Discover models from Venice API with fallback to static catalog.
 * The /models endpoint is public and doesn't require authentication.
 */
export async function discoverVeniceModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
  }

  try {
    const response = await fetch(`${VENICE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[venice-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
    }

    const data = (await response.json()) as VeniceModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[venice-models] No models found from API, using static catalog");
      return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
    }

    // Merge discovered models with catalog metadata
    const catalogById = new Map<string, VeniceCatalogEntry>(
      VENICE_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of data.data) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        // Use catalog metadata for known models
        models.push(buildVeniceModelDefinition(catalogEntry));
      } else {
        // Create definition for newly discovered models not in catalog
        const isReasoning =
          apiModel.model_spec.capabilities.supportsReasoning ||
          apiModel.id.toLowerCase().includes("thinking") ||
          apiModel.id.toLowerCase().includes("reason") ||
          apiModel.id.toLowerCase().includes("r1");

        const hasVision = apiModel.model_spec.capabilities.supportsVision;

        models.push({
          id: apiModel.id,
          name: apiModel.model_spec.name || apiModel.id,
          reasoning: isReasoning,
          input: hasVision ? ["text", "image"] : ["text"],
          cost: VENICE_DEFAULT_COST,
          contextWindow: apiModel.model_spec.availableContextTokens || 128000,
          maxTokens: 8192,
        });
      }
    }

    return models.length > 0 ? models : VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
  } catch (error) {
    console.warn(`[venice-models] Discovery failed: ${String(error)}, using static catalog`);
    return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
  }
}
