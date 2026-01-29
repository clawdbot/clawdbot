import type { ModelDefinitionConfig } from "../config/types.js";

// Clarifai OpenAI-compatible endpoint
// Docs: https://docs.clarifai.com/api-guide/predict/llms
// Note: The model ID must be the FULL Clarifai model URL
// Format: https://clarifai.com/{user_id}/{app_id}/models/{model_id}
// Or with version: https://clarifai.com/{user_id}/{app_id}/models/{model_id}/versions/{version_id}
export const CLARIFAI_BASE_URL = "https://api.clarifai.com/v2/ext/openai/v1";

// Default model - the FULL URL is required as the model name
// Example: https://clarifai.com/openai/chat-completion/models/gpt-oss-120b
export const CLARIFAI_DEFAULT_MODEL_ID =
  "https://clarifai.com/openai/chat-completion/models/gpt-oss-120b";
export const CLARIFAI_DEFAULT_MODEL_REF = "clarifai/gpt-oss-120b";

// Clarifai uses PAT (Personal Access Token) for authentication
// Pricing varies by model and compute tier
export const CLARIFAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Clarifai model catalog.
 *
 * IMPORTANT: Clarifai requires the FULL model URL as the model ID.
 * Format: https://clarifai.com/{user_id}/{app_id}/models/{model_id}
 * Or with version: https://clarifai.com/{user_id}/{app_id}/models/{model_id}/versions/{version_id}
 *
 * Examples:
 * - https://clarifai.com/openai/chat-completion/models/gpt-oss-120b/versions/f1d2a....
 *
 * Authentication: Uses PAT (Personal Access Token), also called API key.
 * Set via CLARIFAI_API_KEY or CLARIFAI_PAT environment variable.
 *
 * Browse available models at: https://clarifai.com/explore/models
 */
export const CLARIFAI_MODEL_CATALOG = [
  {
    id: "https://clarifai.com/openai/chat-completion/models/gpt-oss-120b",
    name: "GPT-OSS 120B (via Clarifai)",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    contextWindow: 128000,
    maxTokens: 4096,
  },
];

export function buildClarifaiModelDefinition(
  model: (typeof CLARIFAI_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: CLARIFAI_DEFAULT_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Discover models from Clarifai API.
 * Falls back to static catalog if API is unreachable.
 */
export async function discoverClarifaiModels(): Promise<ModelDefinitionConfig[]> {
  // For now, use static catalog
  // Clarifai's model listing requires specific API calls that differ from
  // the OpenAI-compatible endpoint, so we use a curated catalog
  return CLARIFAI_MODEL_CATALOG.map(buildClarifaiModelDefinition);
}
