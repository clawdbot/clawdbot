import { fetchWithTimeout } from "openclaw/plugin-sdk/provider-http";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("deepinfra-models");

export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
export const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?sort_by=openclaw&filter=with_meta`;

export const DEEPINFRA_DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V3.2";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;

export const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
export const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;

export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 163840,
    cost: { input: 0.26, output: 0.38, cacheRead: 0.13, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 202752,
    cost: { input: 1.05, output: 3.5, cacheRead: 0.205000005, cacheWrite: 0 },
  },
  {
    id: "stepfun-ai/Step-3.5-Flash",
    name: "Step 3.5 Flash",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
  },
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 196608,
    cost: { input: 0.15, output: 1.15, cacheRead: 0.03, cacheWrite: 0 },
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: { input: 0.45, output: 2.25, cacheRead: 0.070000002, cacheWrite: 0 },
  },
  {
    id: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
    name: "NVIDIA Nemotron 3 Super 120B A12B",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    name: "Llama 3.3 70B Instruct Turbo",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 131072,
    cost: { input: 0.1, output: 0.32, cacheRead: 0, cacheWrite: 0 },
  },
];

const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedModels: ModelDefinitionConfig[] | null = null;
let cachedAt = 0;

export function resetDeepInfraModelCacheForTest(): void {
  cachedModels = null;
  cachedAt = 0;
}

interface DeepInfraModelPricing {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface DeepInfraModelMetadata {
  context_length?: number;
  max_tokens?: number;
  pricing?: DeepInfraModelPricing;
  tags?: string[];
}

interface DeepInfraModelEntry {
  id: string;
  metadata: DeepInfraModelMetadata | null;
}

interface DeepInfraModelsResponse {
  data?: DeepInfraModelEntry[];
}

function parseModality(metadata: DeepInfraModelMetadata): Array<"text" | "image"> {
  return metadata.tags?.includes("vision") ? ["text", "image"] : ["text"];
}

function parseReasoning(metadata: DeepInfraModelMetadata): boolean {
  return Boolean(
    metadata.tags?.includes("reasoning") || metadata.tags?.includes("reasoning_effort"),
  );
}

export function buildDeepInfraModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsUsageInStreaming: model.compat?.supportsUsageInStreaming ?? true,
    },
  };
}

function toModelDefinition(entry: DeepInfraModelEntry): ModelDefinitionConfig {
  const metadata = entry.metadata;
  if (!metadata) {
    throw new Error("missing metadata");
  }
  return buildDeepInfraModelDefinition({
    id: entry.id,
    name: entry.id,
    reasoning: parseReasoning(metadata),
    input: parseModality(metadata),
    contextWindow: metadata.context_length ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: metadata.max_tokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
    cost: {
      input: metadata.pricing?.input_tokens ?? 0,
      output: metadata.pricing?.output_tokens ?? 0,
      cacheRead: metadata.pricing?.cache_read_tokens ?? 0,
      cacheWrite: 0,
    },
  });
}

function staticCatalog(): ModelDefinitionConfig[] {
  return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
}

export async function discoverDeepInfraModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticCatalog();
  }

  if (cachedModels && Date.now() - cachedAt < DISCOVERY_CACHE_TTL_MS) {
    return [...cachedModels];
  }

  try {
    const response = await fetchWithTimeout(
      DEEPINFRA_MODELS_URL,
      {
        headers: { Accept: "application/json" },
      },
      DISCOVERY_TIMEOUT_MS,
    );
    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return staticCatalog();
    }

    const body = (await response.json()) as DeepInfraModelsResponse;
    if (!Array.isArray(body.data) || body.data.length === 0) {
      log.warn("No models found from DeepInfra API, using static catalog");
      return staticCatalog();
    }

    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];
    for (const entry of body.data) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id || seen.has(id) || !entry.metadata) {
        continue;
      }
      try {
        models.push(toModelDefinition({ ...entry, id }));
        seen.add(id);
      } catch (error) {
        log.warn(`Skipping malformed model entry "${id}": ${String(error)}`);
      }
    }

    if (models.length === 0) {
      return staticCatalog();
    }
    cachedModels = models;
    cachedAt = Date.now();
    return [...models];
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticCatalog();
  }
}
