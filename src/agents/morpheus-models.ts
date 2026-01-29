import type { ModelDefinitionConfig } from "../config/types.js";

export const MORPHEUS_BASE_URL = "https://api.mor.org/api/v1";
export const MORPHEUS_DEFAULT_MODEL_ID = "kimi-k2-thinking";
export const MORPHEUS_DEFAULT_MODEL_REF = `morpheus/${MORPHEUS_DEFAULT_MODEL_ID}`;

// Morpheus is currently FREE during Open Beta (until 1/31/26).
// Set costs to 0 as pricing will be implemented later.
export const MORPHEUS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const MORPHEUS_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
} as const;

/**
 * Complete catalog of Morpheus Inference API models.
 *
 * Morpheus is a decentralized inference marketplace that provides access to
 * open-source AI models. The API is fully OpenAI-compatible.
 *
 * Model availability depends on active providers in the marketplace.
 * This catalog serves as a fallback when the Morpheus API is unreachable.
 *
 * Models with the `:web` suffix have web search capabilities enabled.
 */
export const MORPHEUS_MODEL_CATALOG = [
  // ============================================
  // FLAGSHIP MODELS
  // ============================================
  {
    id: "qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
    tags: ["Code"],
  },
  {
    id: "hermes-3-llama-3.1-405b",
    name: "Hermes 3 Llama 3.1 405B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    tags: ["General"],
  },
  {
    id: "gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    tags: ["General"],
  },

  // ============================================
  // REASONING MODELS
  // ============================================
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
    tags: ["Reasoning", "Code"],
  },
  {
    id: "glm-4.7-thinking",
    name: "GLM 4.7 Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 8192,
    tags: ["Reasoning"],
  },
  {
    id: "glm-4.7",
    name: "GLM 4.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 8192,
    tags: ["Reasoning"],
  },
  {
    id: "qwen3-235b",
    name: "Qwen3 235B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    tags: ["Reasoning"],
  },

  // ============================================
  // MID-SIZE MODELS
  // ============================================
  {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    tags: ["General"],
  },
  {
    id: "qwen3-next-80b",
    name: "Qwen3 Next 80B",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 8192,
    tags: ["General"],
  },
  {
    id: "mistral-31-24b",
    name: "Mistral 31 24B",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 8192,
    tags: ["Vision"],
  },
  {
    id: "venice-uncensored",
    name: "Venice Uncensored",
    reasoning: false,
    input: ["text"],
    contextWindow: 32000,
    maxTokens: 8192,
    tags: ["Uncensored"],
  },
  {
    id: "hermes-4-14b",
    name: "Hermes 4 14B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    tags: ["General"],
  },

  // ============================================
  // FAST MODELS
  // ============================================
  {
    id: "llama-3.2-3b",
    name: "Llama 3.2 3B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    tags: ["Fast"],
  },
  {
    id: "qwen3-4b",
    name: "Qwen3 4B",
    reasoning: true,
    input: ["text"],
    contextWindow: 32000,
    maxTokens: 8192,
    tags: ["Fast", "Reasoning"],
  },
] as const;

export type MorpheusCatalogEntry = (typeof MORPHEUS_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from a Morpheus catalog entry.
 */
export function buildMorpheusModelDefinition(entry: MorpheusCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: MORPHEUS_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: MORPHEUS_COMPAT,
  };
}

// Morpheus API response types
interface MorpheusModel {
  id: string;
  blockchainID: string;
  created: number;
  tags: string[];
  modelType: "LLM" | "TTS" | "STT" | "EMBEDDING";
}

interface MorpheusModelsResponse {
  object: string;
  data: MorpheusModel[];
}

/**
 * Infer model properties from Morpheus API model data.
 */
function inferModelProperties(model: MorpheusModel): {
  reasoning: boolean;
  input: string[];
  contextWindow: number;
} {
  const id = model.id.toLowerCase();
  const tags = model.tags.map((t) => t.toLowerCase());

  // Infer reasoning from model name or tags
  const reasoning =
    id.includes("thinking") ||
    id.includes("reason") ||
    id.includes("r1") ||
    tags.includes("reasoning");

  // Infer vision support from tags
  const hasVision = id.includes("vision") || id.includes("vl-") || id.includes("-vl");
  const input = hasVision ? ["text", "image"] : ["text"];

  // Infer context window from size tag or model name
  let contextWindow = 128000;
  if (id.includes("qwen3-coder") || id.includes("kimi-k2") || id.includes("qwen3-next")) {
    contextWindow = 256000;
  } else if (id.includes("glm-4.7")) {
    contextWindow = 198000;
  } else if (id.includes("venice-uncensored") || id.includes("qwen3-4b")) {
    contextWindow = 32000;
  }

  return { reasoning, input, contextWindow };
}

/**
 * Discover models from Morpheus API with fallback to static catalog.
 * The /models endpoint is public and doesn't require authentication.
 */
export async function discoverMorpheusModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return MORPHEUS_MODEL_CATALOG.map(buildMorpheusModelDefinition);
  }

  try {
    const response = await fetch(`${MORPHEUS_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[morpheus-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return MORPHEUS_MODEL_CATALOG.map(buildMorpheusModelDefinition);
    }

    const data = (await response.json()) as MorpheusModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[morpheus-models] No models found from API, using static catalog");
      return MORPHEUS_MODEL_CATALOG.map(buildMorpheusModelDefinition);
    }

    // Filter to LLM models only and merge with catalog metadata
    const llmModels = data.data.filter((m) => m.modelType === "LLM");
    const catalogById = new Map<string, MorpheusCatalogEntry>(
      MORPHEUS_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of llmModels) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        // Use catalog metadata for known models
        models.push(buildMorpheusModelDefinition(catalogEntry));
      } else {
        // Create definition for newly discovered models not in catalog
        const inferred = inferModelProperties(apiModel);
        const displayName = apiModel.id
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ");

        models.push({
          id: apiModel.id,
          name: displayName,
          reasoning: inferred.reasoning,
          input: inferred.input as ("text" | "image")[],
          cost: MORPHEUS_DEFAULT_COST,
          contextWindow: inferred.contextWindow,
          maxTokens: 8192,
          compat: MORPHEUS_COMPAT,
        });
      }
    }

    return models.length > 0 ? models : MORPHEUS_MODEL_CATALOG.map(buildMorpheusModelDefinition);
  } catch (error) {
    console.warn(`[morpheus-models] Discovery failed: ${String(error)}, using static catalog`);
    return MORPHEUS_MODEL_CATALOG.map(buildMorpheusModelDefinition);
  }
}
