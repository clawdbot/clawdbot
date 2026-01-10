/**
 * OpenCode Zen model catalog with dynamic fetching, caching, and static fallback.
 *
 * OpenCode Zen is a $200/month subscription that provides proxy access to multiple
 * AI models (Claude, GPT, Gemini, etc.) through a single API endpoint.
 *
 * API endpoint: https://opencode.ai/zen/v1
 * Auth URL: https://opencode.ai/auth
 */

import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";

export const OPENCODE_ZEN_API_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_ZEN_DEFAULT_MODEL = "claude-opus-4-5";
export const OPENCODE_ZEN_DEFAULT_MODEL_REF = `opencode/${OPENCODE_ZEN_DEFAULT_MODEL}`;

// Cache for fetched models (1 hour TTL)
let cachedModels: ModelDefinitionConfig[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Model aliases for convenient shortcuts.
 * Users can use "opus" instead of "claude-opus-4-5", etc.
 */
export const OPENCODE_ZEN_MODEL_ALIASES: Record<string, string> = {
  // Claude
  opus: "claude-opus-4-5",
  "opus-4.5": "claude-opus-4-5",
  "opus-4": "claude-opus-4-5",

  // Legacy Claude aliases (OpenCode Zen rotates model catalogs; keep old keys working).
  sonnet: "claude-opus-4-5",
  "sonnet-4": "claude-opus-4-5",
  haiku: "claude-opus-4-5",
  "haiku-3.5": "claude-opus-4-5",

  // GPT-5.x family
  gpt5: "gpt-5.2",
  "gpt-5": "gpt-5.2",
  "gpt-5.1": "gpt-5.1",

  // Legacy GPT aliases (keep old config/docs stable; map to closest current equivalents).
  gpt4: "gpt-5.1",
  "gpt-4": "gpt-5.1",
  "gpt-mini": "gpt-5.1-codex-mini",

  // Legacy O-series aliases (no longer in the Zen catalog; map to a strong default).
  o1: "gpt-5.2",
  o3: "gpt-5.2",
  "o3-mini": "gpt-5.1-codex-mini",

  // Codex family
  codex: "gpt-5.1-codex",
  "codex-mini": "gpt-5.1-codex-mini",
  "codex-max": "gpt-5.1-codex-max",

  // Gemini
  gemini: "gemini-3-pro",
  "gemini-pro": "gemini-3-pro",
  "gemini-3": "gemini-3-pro",
  flash: "gemini-3-flash",
  "gemini-flash": "gemini-3-flash",

  // Legacy Gemini 2.5 aliases (map to the nearest current Gemini tier).
  "gemini-2.5": "gemini-3-pro",
  "gemini-2.5-pro": "gemini-3-pro",
  "gemini-2.5-flash": "gemini-3-flash",

  // GLM (free + alpha)
  glm: "glm-4.7-free",
  "glm-free": "glm-4.7-free",
  "alpha-glm": "alpha-glm-4.7",

  // MiniMax
  minimax: "minimax-m2.1-free",
  "minimax-free": "minimax-m2.1-free",
};

/**
 * Resolve a model alias to its full model ID.
 * Returns the input if no alias exists.
 */
export function resolveOpencodeZenAlias(modelIdOrAlias: string): string {
  const normalized = modelIdOrAlias.toLowerCase().trim();
  return OPENCODE_ZEN_MODEL_ALIASES[normalized] ?? modelIdOrAlias;
}

/**
 * OpenCode Zen routes models to different APIs based on model family.
 */
export function resolveOpencodeZenModelApi(modelId: string): ModelApi {
  const lower = modelId.toLowerCase();
  if (
    lower.startsWith("claude-") ||
    lower.startsWith("minimax") ||
    lower.startsWith("alpha-gd4")
  ) {
    return "anthropic-messages";
  }
  if (lower.startsWith("gemini-")) {
    return "google-generative-ai";
  }
  if (lower.startsWith("gpt-")) {
    return "openai-responses";
  }
  return "openai-completions";
}

/**
 * Check if a model supports image input.
 */
function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes("glm") || lower.includes("minimax")) {
    return false;
  }
  return true;
}

const MODEL_COSTS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "gpt-5.1-codex": {
    input: 1.07,
    output: 8.5,
    cacheRead: 0.107,
    cacheWrite: 0,
  },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "alpha-glm-4.7": { input: 0.6, output: 2.2, cacheRead: 0.6, cacheWrite: 0 },
  "gpt-5.1-codex-mini": {
    input: 0.25,
    output: 2,
    cacheRead: 0.025,
    cacheWrite: 0,
  },
  "gpt-5.1": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "glm-4.7-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gpt-5.1-codex-max": {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  },
  "minimax-m2.1-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.1-codex": 400000,
  "claude-opus-4-5": 200000,
  "gemini-3-pro": 1048576,
  "alpha-glm-4.7": 204800,
  "gpt-5.1-codex-mini": 400000,
  "gpt-5.1": 400000,
  "glm-4.7-free": 204800,
  "gemini-3-flash": 1048576,
  "gpt-5.1-codex-max": 400000,
  "minimax-m2.1-free": 204800,
  "gpt-5.2": 400000,
};

function getDefaultContextWindow(modelId: string): number {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000;
}

const MODEL_MAX_TOKENS: Record<string, number> = {
  "gpt-5.1-codex": 128000,
  "claude-opus-4-5": 64000,
  "gemini-3-pro": 65536,
  "alpha-glm-4.7": 131072,
  "gpt-5.1-codex-mini": 128000,
  "gpt-5.1": 128000,
  "glm-4.7-free": 131072,
  "gemini-3-flash": 65536,
  "gpt-5.1-codex-max": 128000,
  "minimax-m2.1-free": 131072,
  "gpt-5.2": 128000,
};

function getDefaultMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] ?? 8192;
}

/**
 * Build a ModelDefinitionConfig from a model ID.
 */
function buildModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: formatModelName(modelId),
    api: resolveOpencodeZenModelApi(modelId),
    // Treat Zen models as reasoning-capable so defaults pick thinkLevel="low" unless users opt out.
    reasoning: true,
    input: supportsImageInput(modelId) ? ["text", "image"] : ["text"],
    cost: MODEL_COSTS[modelId] ?? DEFAULT_COST,
    contextWindow: getDefaultContextWindow(modelId),
    maxTokens: getDefaultMaxTokens(modelId),
  };
}

/**
 * Format a model ID into a human-readable name.
 */
const MODEL_NAMES: Record<string, string> = {
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "claude-opus-4-5": "Claude Opus 4.5",
  "gemini-3-pro": "Gemini 3 Pro",
  "alpha-glm-4.7": "Alpha GLM-4.7",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.1": "GPT-5.1",
  "glm-4.7-free": "GLM-4.7",
  "gemini-3-flash": "Gemini 3 Flash",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "minimax-m2.1-free": "MiniMax M2.1",
  "gpt-5.2": "GPT-5.2",
};

function formatModelName(modelId: string): string {
  if (MODEL_NAMES[modelId]) {
    return MODEL_NAMES[modelId];
  }

  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Static fallback models when API is unreachable.
 */
export function getOpencodeZenStaticFallbackModels(): ModelDefinitionConfig[] {
  const modelIds = [
    "gpt-5.1-codex",
    "claude-opus-4-5",
    "gemini-3-pro",
    "alpha-glm-4.7",
    "gpt-5.1-codex-mini",
    "gpt-5.1",
    "glm-4.7-free",
    "gemini-3-flash",
    "gpt-5.1-codex-max",
    "minimax-m2.1-free",
    "gpt-5.2",
  ];

  return modelIds.map(buildModelDefinition);
}

/**
 * Response shape from OpenCode Zen /models endpoint.
 * Returns OpenAI-compatible format.
 */
interface ZenModelsResponse {
  data: Array<{
    id: string;
    object: "model";
    created?: number;
    owned_by?: string;
  }>;
}

/**
 * Fetch models from the OpenCode Zen API.
 * Uses caching with 1-hour TTL.
 *
 * @param apiKey - OpenCode Zen API key for authentication
 * @returns Array of model definitions, or static fallback on failure
 */
export async function fetchOpencodeZenModels(
  apiKey?: string,
): Promise<ModelDefinitionConfig[]> {
  // Return cached models if still valid
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${OPENCODE_ZEN_API_BASE_URL}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(
        `API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as ZenModelsResponse;

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from /models endpoint");
    }

    const models = data.data.map((model) => buildModelDefinition(model.id));

    cachedModels = models;
    cacheTimestamp = now;

    return models;
  } catch (error) {
    console.warn(
      `[opencode-zen] Failed to fetch models, using static fallback: ${String(error)}`,
    );
    return getOpencodeZenStaticFallbackModels();
  }
}

/**
 * Clear the model cache (useful for testing or forcing refresh).
 */
export function clearOpencodeZenModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}
