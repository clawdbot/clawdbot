import type { ModelDefinitionConfig } from "../config/types.js";

/**
 * Maple AI Provider
 *
 * Maple AI is a privacy-focused AI provider that uses Confidential Computing (TEEs)
 * to provide end-to-end encryption with cryptographic attestations. Users run the
 * Maple desktop app or Docker container, then point their tools at the local proxy.
 *
 * Default proxy URL: http://127.0.0.1:8080/v1
 */

export const MAPLE_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
export const MAPLE_DEFAULT_MODEL_ID = "kimi-k2-thinking";
export const MAPLE_DEFAULT_MODEL_REF = `maple/${MAPLE_DEFAULT_MODEL_ID}`;

// Maple uses flat pricing per million tokens
export const MAPLE_DEFAULT_COST = {
  input: 4,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Static catalog of Maple AI models.
 *
 * All models run in TEE-based Confidential Computing environments,
 * providing end-to-end encryption and cryptographic attestations.
 *
 * This catalog serves as a fallback when the Maple API is unreachable.
 */
export const MAPLE_MODEL_CATALOG = [
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    description: "Complex agentic workflows, multi-step coding, web research",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
    cost: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT OSS 120B",
    description: "Creative writing, structured data",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "deepseek-r1-0528",
    name: "DeepSeek R1",
    description: "Research, advanced math, coding",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "qwen3-coder-480b",
    name: "Qwen3 Coder 480B",
    description: "Agentic coding, large codebase analysis, browser automation",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "qwen3-vl-30b",
    name: "Qwen3 VL 30B",
    description: "Image and video analysis, screenshot-to-code, OCR, GUI automation",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
    cost: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    description: "General reasoning, conversation",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gemma-3-27b",
    name: "Gemma 3 27B",
    description: "General purpose, efficient",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  },
] as const;

export type MapleCatalogEntry = (typeof MAPLE_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from a Maple catalog entry.
 */
export function buildMapleModelDefinition(entry: MapleCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: entry.cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

// Maple API response types (OpenAI-compatible)
interface MapleModel {
  id: string;
  object: string;
  owned_by?: string;
}

interface MapleModelsResponse {
  object: string;
  data: MapleModel[];
}

/**
 * Discover models from Maple API with fallback to static catalog.
 * Requires authentication (Bearer token).
 */
export async function discoverMapleModels(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return MAPLE_MODEL_CATALOG.map(buildMapleModelDefinition);
  }

  const baseUrl = params?.baseUrl ?? MAPLE_DEFAULT_BASE_URL;
  const apiKey = params?.apiKey;

  // If no API key, return static catalog
  if (!apiKey) {
    return MAPLE_MODEL_CATALOG.map(buildMapleModelDefinition);
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[maple-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return MAPLE_MODEL_CATALOG.map(buildMapleModelDefinition);
    }

    const data = (await response.json()) as MapleModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[maple-models] No models found from API, using static catalog");
      return MAPLE_MODEL_CATALOG.map(buildMapleModelDefinition);
    }

    // Merge discovered models with catalog metadata
    const catalogById = new Map<string, MapleCatalogEntry>(
      MAPLE_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of data.data) {
      const catalogEntry = catalogById.get(apiModel.id);
      if (catalogEntry) {
        // Use catalog metadata for known models
        models.push(buildMapleModelDefinition(catalogEntry));
      } else {
        // Create definition for newly discovered models not in catalog
        const isReasoning =
          apiModel.id.toLowerCase().includes("thinking") ||
          apiModel.id.toLowerCase().includes("reason") ||
          apiModel.id.toLowerCase().includes("r1");

        models.push({
          id: apiModel.id,
          name: apiModel.id,
          reasoning: isReasoning,
          input: ["text"],
          cost: MAPLE_DEFAULT_COST,
          contextWindow: 128000,
          maxTokens: 8192,
        });
      }
    }

    return models.length > 0 ? models : MAPLE_MODEL_CATALOG.map(buildMapleModelDefinition);
  } catch (error) {
    console.warn(`[maple-models] Discovery failed: ${String(error)}, using static catalog`);
    return MAPLE_MODEL_CATALOG.map(buildMapleModelDefinition);
  }
}
