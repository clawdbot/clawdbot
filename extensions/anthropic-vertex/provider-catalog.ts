import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
/**
 * Static Anthropic Vertex model catalog builder. It derives provider base URLs
 * from region configuration and publishes Claude model metadata.
 */
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  modelCostsEqual,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveAnthropicVertexClientRegion, resolveAnthropicVertexRegion } from "./region.js";
/** Default Anthropic Vertex model used for implicit provider catalogs. */
export const ANTHROPIC_VERTEX_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS = 128_000;
// Vertex's introductory rate expires at the documented UTC month boundary.
const SONNET_5_STANDARD_PRICING_START_MS = Date.UTC(2026, 8, 1);
const SONNET_5_SUPPORTED_REGIONS = new Set(["global", "us", "eu"]);
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const SONNET_5_COST = {
  promotional: {
    global: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    multiRegion: { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 },
  },
  standard: {
    global: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    multiRegion: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
  },
} as const;

function buildAnthropicVertexModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
  maxTokens: number;
  mediaInput?: ModelDefinitionConfig["mediaInput"];
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
    ...(params.mediaInput ? { mediaInput: params.mediaInput } : {}),
    ...(params.thinkingLevelMap ? { thinkingLevelMap: params.thinkingLevelMap } : {}),
  };
}

function resolveSonnet5Cost(
  region: string,
  nowMs: number = Date.now(),
): ModelDefinitionConfig["cost"] | undefined {
  const normalizedRegion = normalizeLowercaseStringOrEmpty(region);
  if (!SONNET_5_SUPPORTED_REGIONS.has(normalizedRegion)) {
    return undefined;
  }
  const pricingPeriod = nowMs >= SONNET_5_STANDARD_PRICING_START_MS ? "standard" : "promotional";
  return normalizedRegion === "global"
    ? SONNET_5_COST[pricingPeriod].global
    : SONNET_5_COST[pricingPeriod].multiRegion;
}

function buildAnthropicVertexCatalog(region: string, nowMs: number): ModelDefinitionConfig[] {
  const sonnet5Cost = resolveSonnet5Cost(region, nowMs);
  const sonnet5 = sonnet5Cost
    ? [
        buildAnthropicVertexModel({
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
          input: ["text", "image"],
          cost: sonnet5Cost,
          maxTokens: 128_000,
          mediaInput: {
            image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
          },
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }),
      ]
    : [];

  return [
    buildAnthropicVertexModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      maxTokens: ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    }),
    buildAnthropicVertexModel({
      id: "claude-mythos-5",
      name: "Claude Mythos 5",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      maxTokens: ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    }),
    ...sonnet5,
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
      thinkingLevelMap: { xhigh: null, max: "max" },
    }),
    buildAnthropicVertexModel({
      id: ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
      name: "Claude Sonnet 4.6",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      maxTokens: 128000,
      thinkingLevelMap: { xhigh: null, max: "max" },
    }),
  ];
}

/** Restore required generation metadata after explicit models replace an implicit row. */
export function normalizeAnthropicVertexResolvedModel(
  modelId: string,
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  const ref = { id: modelId, params: model.params };
  const fable5 = resolveClaudeFable5ModelIdentity(ref) !== undefined;
  const mythos5 = resolveClaudeMythos5ModelIdentity(ref) !== undefined;
  const sonnet5 = resolveClaudeSonnet5ModelIdentity(ref) !== undefined;
  if (!fable5 && !mythos5 && !sonnet5) {
    return undefined;
  }
  const input: ProviderRuntimeModel["input"] = model.input.includes("image")
    ? model.input
    : [...model.input, "image"];
  const nativeThinkingLevelMap = {
    ...(fable5 || mythos5 ? { off: "low" as const, minimal: "low" as const } : {}),
    xhigh: "xhigh",
    max: "max",
  };
  const thinkingLevelMap = {
    ...nativeThinkingLevelMap,
    ...model.thinkingLevelMap,
  };
  const nativeThinkingLevelsMatch =
    model.thinkingLevelMap?.xhigh === "xhigh" &&
    model.thinkingLevelMap.max === "max" &&
    (!(fable5 || mythos5) ||
      (model.thinkingLevelMap.off === "low" && model.thinkingLevelMap.minimal === "low"));
  const cost = sonnet5
    ? resolveSonnet5Cost(resolveAnthropicVertexClientRegion({ baseUrl: model.baseUrl }))
    : undefined;
  const costMatches = !cost || modelCostsEqual(model.cost, cost);
  if (
    model.reasoning &&
    input === model.input &&
    model.contextWindow === ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW &&
    model.contextTokens === ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW &&
    (model.maxTokens ?? 0) >= ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS &&
    nativeThinkingLevelsMatch &&
    costMatches
  ) {
    return undefined;
  }
  return {
    ...model,
    reasoning: true,
    input,
    contextWindow: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    contextTokens: ANTHROPIC_VERTEX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: Math.max(model.maxTokens ?? 0, ANTHROPIC_VERTEX_CLAUDE_5_MAX_TOKENS),
    thinkingLevelMap,
    ...(cost ? { cost } : {}),
  };
}

/** Build the implicit Anthropic Vertex provider config for the current env. */
export function buildAnthropicVertexProvider(params?: {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
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
    models: buildAnthropicVertexCatalog(region, params?.nowMs ?? Date.now()),
  };
}
