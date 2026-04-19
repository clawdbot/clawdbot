import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
export const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";
export const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;
export const MISTRAL_DEFAULT_CONTEXT_WINDOW = 262144;
export const MISTRAL_DEFAULT_MAX_TOKENS = 16384;
export const MISTRAL_DEFAULT_COST = {
  input: 0.5,
  output: 1.5,
  cacheRead: 0,
  cacheWrite: 0,
};

const MISTRAL_MODEL_CATALOG = [
  {
    id: "codestral-latest",
    name: "Codestral (latest)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 4096,
  },
  {
    id: "devstral-medium-latest",
    name: "Devstral 2 (latest)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.4, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "magistral-small",
    name: "Magistral Small",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 40000,
  },
  {
    id: "mistral-large-latest",
    name: "Mistral Large (latest)",
    reasoning: false,
    input: ["text", "image"],
    cost: MISTRAL_DEFAULT_COST,
    contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
  },
  {
    id: "mistral-medium-2508",
    name: "Mistral Medium 3.1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.4, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "mistral-small-latest",
    name: "Mistral Small (latest)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.3, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "pixtral-large-latest",
    name: "Pixtral Large (latest)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32768,
  },
] as const satisfies readonly ModelDefinitionConfig[];

export function buildMistralModelDefinition(): ModelDefinitionConfig {
  return (
    MISTRAL_MODEL_CATALOG.find((model) => model.id === MISTRAL_DEFAULT_MODEL_ID) ?? {
      id: MISTRAL_DEFAULT_MODEL_ID,
      name: "Mistral Large",
      reasoning: false,
      input: ["text", "image"],
      cost: MISTRAL_DEFAULT_COST,
      contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
      maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
    }
  );
}

export function buildMistralCatalogModels(): ModelDefinitionConfig[] {
  return MISTRAL_MODEL_CATALOG.map((model) =>
    Object.assign({}, model, { input: [...model.input] }),
  );
}
