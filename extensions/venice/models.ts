import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { parseVeniceModelPricing } from "./pricing-api.js";

const VENICE_MANIFEST_CATALOG = manifest.modelCatalog.providers.venice;

export const VENICE_BASE_URL = VENICE_MANIFEST_CATALOG.baseUrl;
export const VENICE_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "venice")!;

const VENICE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const VENICE_DEFAULT_CONTEXT_WINDOW = 128_000;
const VENICE_DEFAULT_MAX_TOKENS = 4096;
const VENICE_DISCOVERY_HARD_MAX_TOKENS = 131_072;
const VENICE_DISCOVERY_TIMEOUT_MS = 10_000;
const VENICE_DISCOVERY_CACHE_TTL_MS = 60_000;

function decorateVeniceModelDefinition(entry: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...entry,
    compat: {
      supportsUsageInStreaming: false,
      ...entry.compat,
    },
  };
}

/** Venice's decorated network-free fallback catalog. */
export const VENICE_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: "venice",
  catalog: VENICE_MANIFEST_CATALOG,
}).models.map(decorateVeniceModelDefinition);

interface VeniceModelSpec {
  name: string;
  privacy: "private" | "anonymized";
  availableContextTokens?: number;
  maxCompletionTokens?: number;
  pricing?: unknown;
  capabilities?: {
    supportsReasoning?: boolean;
    supportsVision?: boolean;
    supportsFunctionCalling?: boolean;
  };
}

interface VeniceModel {
  id: string;
  model_spec?: VeniceModelSpec;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveApiMaxCompletionTokens(params: {
  apiModel: VeniceModel;
  knownMaxTokens?: number;
}): number | undefined {
  const raw = normalizePositiveInt(params.apiModel.model_spec?.maxCompletionTokens);
  if (!raw) {
    return undefined;
  }
  const contextWindow = normalizePositiveInt(params.apiModel.model_spec?.availableContextTokens);
  const knownMaxTokens =
    typeof params.knownMaxTokens === "number" && Number.isFinite(params.knownMaxTokens)
      ? Math.floor(params.knownMaxTokens)
      : undefined;
  const hardCap = knownMaxTokens ?? VENICE_DISCOVERY_HARD_MAX_TOKENS;
  const fallbackContextWindow = knownMaxTokens ?? VENICE_DEFAULT_CONTEXT_WINDOW;
  return Math.min(raw, contextWindow ?? fallbackContextWindow, hardCap);
}

function resolveApiSupportsTools(apiModel: VeniceModel): boolean | undefined {
  const supportsFunctionCalling = apiModel.model_spec?.capabilities?.supportsFunctionCalling;
  return typeof supportsFunctionCalling === "boolean" ? supportsFunctionCalling : undefined;
}

function projectVeniceModels(
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
): ModelDefinitionConfig[] {
  const catalogById = new Map(fallback.models.map((model) => [model.id, model]));
  const models: ModelDefinitionConfig[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const apiModel = row as VeniceModel;
    if (typeof apiModel.id !== "string" || !apiModel.id.trim()) {
      continue;
    }
    const catalogEntry = catalogById.get(apiModel.id);
    const liveCost = parseVeniceModelPricing(apiModel.model_spec?.pricing);
    const apiMaxTokens = resolveApiMaxCompletionTokens({
      apiModel,
      knownMaxTokens: catalogEntry?.maxTokens,
    });
    const apiSupportsTools = resolveApiSupportsTools(apiModel);
    if (catalogEntry) {
      const definition: ModelDefinitionConfig = {
        ...catalogEntry,
        input: [...catalogEntry.input],
        cost: liveCost ?? { ...catalogEntry.cost },
        ...(catalogEntry.compat ? { compat: { ...catalogEntry.compat } } : {}),
      };
      if (apiMaxTokens !== undefined) {
        definition.maxTokens = apiMaxTokens;
      }
      if (apiSupportsTools === false) {
        definition.compat = {
          ...definition.compat,
          supportsTools: false,
        };
      }
      models.push(definition);
    } else {
      const apiSpec = apiModel.model_spec;
      const lowerModelId = normalizeLowercaseStringOrEmpty(apiModel.id);
      const isReasoning =
        apiSpec?.capabilities?.supportsReasoning ||
        lowerModelId.includes("thinking") ||
        lowerModelId.includes("reason") ||
        lowerModelId.includes("r1");
      const hasVision = apiSpec?.capabilities?.supportsVision === true;
      models.push({
        id: apiModel.id,
        name: apiSpec?.name || apiModel.id,
        reasoning: isReasoning,
        input: hasVision ? ["text", "image"] : ["text"],
        cost: liveCost ?? VENICE_DEFAULT_COST,
        contextWindow:
          normalizePositiveInt(apiSpec?.availableContextTokens) ?? VENICE_DEFAULT_CONTEXT_WINDOW,
        maxTokens: apiMaxTokens ?? VENICE_DEFAULT_MAX_TOKENS,
        compat: {
          supportsUsageInStreaming: false,
          ...(apiSupportsTools === false ? { supportsTools: false } : {}),
        },
      });
    }
  }
  return models;
}

export const VENICE_MODEL_DISCOVERY_OPTIONS = {
  timeoutMs: VENICE_DISCOVERY_TIMEOUT_MS,
  ttlMs: VENICE_DISCOVERY_CACHE_TTL_MS,
  authentication: "none",
  projectRows: projectVeniceModels,
} as const;
