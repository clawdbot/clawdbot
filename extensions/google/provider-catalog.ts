import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const GOOGLE_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const GOOGLE_GEMINI_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const GOOGLE_GEMINI_TEXT_MODELS: ModelDefinitionConfig[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash-Lite",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: ["text", "image"],
    cost: GOOGLE_GEMINI_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
];

export function buildGoogleStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_GEMINI_BASE_URL,
    api: "google-generative-ai",
    models: GOOGLE_GEMINI_TEXT_MODELS,
  };
}

export function buildGoogleVertexStaticCatalogProvider(): ModelProviderConfig {
  return {
    baseUrl: GOOGLE_VERTEX_BASE_URL,
    api: "google-vertex",
    models: GOOGLE_GEMINI_TEXT_MODELS,
  };
}
