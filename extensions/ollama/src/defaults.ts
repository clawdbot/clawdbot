// Ollama plugin module implements defaults behavior.
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_DEFAULT_API_KEY = "ollama-local";
const OLLAMA_DOCKER_HOST_BASE_URL = "http://host.docker.internal:11434";
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_GLM52_CLOUD_MODEL_ID = "glm-5.2";
/**
 * Order is a contract: cloud onboarding merges this list ahead of live discovery and takes
 * the first name as `defaultModel` (`setup.runtime.ts`). Reordering this array changes what
 * every new setup selects, so keep the intended default at index 0.
 */
export const OLLAMA_CLOUD_DEFAULT_MODELS = [
  {
    id: "minimax-m2.7",
    contextWindow: 196_608,
    capabilities: ["completion", "thinking", "tools"],
  },
  {
    id: "minimax-m3",
    contextWindow: 524_288,
    capabilities: ["completion", "thinking", "tools", "vision"],
  },
  {
    id: "kimi-k3",
    contextWindow: 1_048_576,
    capabilities: ["completion", "thinking", "tools", "vision"],
  },
  {
    id: "glm-5.1",
    contextWindow: 202_752,
    capabilities: ["completion", "thinking", "tools"],
  },
  {
    id: OLLAMA_GLM52_CLOUD_MODEL_ID,
    contextWindow: 1_000_000,
    capabilities: ["completion", "thinking", "tools"],
  },
  {
    id: "glm-5.3",
    contextWindow: 1_000_000,
    capabilities: ["completion", "thinking", "tools"],
  },
] as const;

/** Cloud models are referenced bare, `:cloud`-suffixed, and `-cloud`-suffixed. */
export function normalizeOllamaCloudModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/(?::cloud|-cloud)$/, "");
}

export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
export const OLLAMA_LOCAL_CONTEXT_TOKENS = 32_768;
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
export const OLLAMA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const OLLAMA_DEFAULT_MODEL = "gemma4";
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

export function resolveOllamaSetupDefaultBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return ["1", "true", "yes", "on"].includes(env.OPENCLAW_DOCKER_SETUP?.trim().toLowerCase() ?? "")
    ? OLLAMA_DOCKER_HOST_BASE_URL
    : OLLAMA_DEFAULT_BASE_URL;
}
