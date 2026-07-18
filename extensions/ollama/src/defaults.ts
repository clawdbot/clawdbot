// Ollama plugin module implements defaults behavior.
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_DOCKER_HOST_BASE_URL = "http://host.docker.internal:11434";
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_GLM52_CLOUD_MODEL_ID = "glm-5.2:cloud";
export const OLLAMA_GLM52_CONTEXT_WINDOW = 1_000_000;
export const OLLAMA_CLOUD_DEFAULT_MODELS = [
  "kimi-k2.5:cloud",
  "minimax-m2.7:cloud",
  "glm-5.1:cloud",
  OLLAMA_GLM52_CLOUD_MODEL_ID,
] as const;

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
