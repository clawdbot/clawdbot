/**
 * Static Anthropic Vertex model catalog builder. It derives provider base URLs
 * from region configuration and publishes Claude model metadata.
 */
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveAnthropicVertexRegion } from "./region.js";
/** Default Anthropic Vertex model used for implicit provider catalogs. */
export const ANTHROPIC_VERTEX_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

function buildAnthropicVertexModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
  maxTokens: number;
  thinkingLevelMap?: ModelDefinitionConfig["thinkingLevelMap"];
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: params.cost,
    contextWindow: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: params.maxTokens,
    ...(params.thinkingLevelMap ? { thinkingLevelMap: params.thinkingLevelMap } : {}),
  };
}

function buildAnthropicVertexCatalog(): ModelDefinitionConfig[] {
  return [
    buildAnthropicVertexModel({
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      maxTokens: 128000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    }),
    buildAnthropicVertexModel({
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      maxTokens: 128000,
    }),
    buildAnthropicVertexModel({
      id: ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
      name: "Claude Sonnet 4.6",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      maxTokens: 128000,
    }),
  ];
}

/** Build the implicit Anthropic Vertex provider config for the current env. */
export function buildAnthropicVertexProvider(params?: {
  env?: NodeJS.ProcessEnv;
}): ModelProviderConfig {
  const region = resolveAnthropicVertexRegion(params?.env);
  const baseUrl =
    normalizeLowercaseStringOrEmpty(region) === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${region}-aiplatform.googleapis.com`;

  return {
    baseUrl,
    api: "anthropic-messages",
    apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
    models: buildAnthropicVertexCatalog(),
  };
}
