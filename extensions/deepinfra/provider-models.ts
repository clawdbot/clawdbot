import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { fetchWithTimeout } from "openclaw/plugin-sdk/provider-http";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const log = createSubsystemLogger("deepinfra-models");

const DEEPINFRA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "deepinfra",
  catalog: manifest.modelCatalog.providers.deepinfra,
});

export const DEEPINFRA_BASE_URL = DEEPINFRA_MANIFEST_PROVIDER.baseUrl;
export const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?sort_by=openclaw&filter=with_meta`;

export const DEEPINFRA_DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V3.2";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;

const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;

export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = DEEPINFRA_MANIFEST_PROVIDER.models;

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
