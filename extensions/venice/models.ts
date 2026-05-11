import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger, retryAsync } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const log = createSubsystemLogger("venice-models");

const VENICE_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "venice",
  catalog: manifest.modelCatalog.providers.venice,
});

export const VENICE_BASE_URL = VENICE_MANIFEST_PROVIDER.baseUrl;
const VENICE_DEFAULT_MODEL_ID = "kimi-k2-5";
export const VENICE_DEFAULT_MODEL_REF = `venice/${VENICE_DEFAULT_MODEL_ID}`;
const VENICE_ALLOWED_HOSTNAMES = ["api.venice.ai"];

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
const VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export const VENICE_MODEL_CATALOG: ModelDefinitionConfig[] = VENICE_MANIFEST_PROVIDER.models;

type VeniceCatalogEntry = ModelDefinitionConfig;

export function buildVeniceModelDefinition(entry: VeniceCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: VENICE_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: {
      supportsUsageInStreaming: false,
      ...entry.compat,
    },
  };
}

interface VeniceModelSpec {
  name: string;
  privacy: "private" | "anonymized";
  availableContextTokens?: number;
  maxCompletionTokens?: number;
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

interface VeniceModelsResponse {
  data: VeniceModel[];
}

class VeniceDiscoveryHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "VeniceDiscoveryHttpError";
    this.status = status;
  }
}

function staticVeniceModelDefinitions(): ModelDefinitionConfig[] {
  return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
}

function hasRetryableNetworkCode(err: unknown): boolean {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      errors?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    const code =
      typeof candidate.code === "string"
        ? candidate.code
        : typeof candidate.errno === "string"
          ? candidate.errno
          : undefined;
    if (code && VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES.has(code)) {
      return true;
    }
    if (candidate.cause) {
      queue.push(candidate.cause);
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors);
    }
  }
  return false;
}

function isRetryableVeniceDiscoveryError(err: unknown): boolean {
  if (err instanceof VeniceDiscoveryHttpError) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (err instanceof TypeError && normalizeLowercaseStringOrEmpty(err.message) === "fetch failed") {
    return true;
  }
  return hasRetryableNetworkCode(err);
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

type VeniceModelDiscoveryOptions = {
  retryDelayMs?: number;
};

export async function discoverVeniceModels(
  options: VeniceModelDiscoveryOptions = {},
): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticVeniceModelDefinitions();
  }

  try {
    const { response, release } = await retryAsync(
      async () => {
        const result = await fetchWithSsrFGuard({
          url: `${VENICE_BASE_URL}/models`,
          signal: AbortSignal.timeout(VENICE_DISCOVERY_TIMEOUT_MS),
          init: {
            headers: {
              Accept: "application/json",
            },
          },
          policy: { allowedHostnames: VENICE_ALLOWED_HOSTNAMES },
          auditContext: "venice-model-discovery",
        });
        const currentResponse = result.response;
        if (
          !currentResponse.ok &&
          VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS.has(currentResponse.status)
        ) {
          await result.release();
          throw new VeniceDiscoveryHttpError(currentResponse.status);
        }
        return result;
      },
      {
        attempts: 3,
        minDelayMs: options.retryDelayMs ?? 300,
        maxDelayMs: options.retryDelayMs ?? 2000,
        jitter: options.retryDelayMs === undefined ? 0.2 : 0,
        label: "venice-model-discovery",
        shouldRetry: isRetryableVeniceDiscoveryError,
      },
    );

    try {
      if (!response.ok) {
        log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
        return staticVeniceModelDefinitions();
      }

      const data = (await response.json()) as VeniceModelsResponse;
      if (!Array.isArray(data.data) || data.data.length === 0) {
        log.warn("No models found from API, using static catalog");
        return staticVeniceModelDefinitions();
      }

      const catalogById = new Map<string, VeniceCatalogEntry>(
        VENICE_MODEL_CATALOG.map((m) => [m.id, m]),
      );
      const models: ModelDefinitionConfig[] = [];

      for (const apiModel of data.data) {
        const catalogEntry = catalogById.get(apiModel.id);
        const apiMaxTokens = resolveApiMaxCompletionTokens({
          apiModel,
          knownMaxTokens: catalogEntry?.maxTokens,
        });
        const apiSupportsTools = resolveApiSupportsTools(apiModel);
        if (catalogEntry) {
          const definition = buildVeniceModelDefinition(catalogEntry);
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
            cost: VENICE_DEFAULT_COST,
            contextWindow:
              normalizePositiveInt(apiSpec?.availableContextTokens) ??
              VENICE_DEFAULT_CONTEXT_WINDOW,
            maxTokens: apiMaxTokens ?? VENICE_DEFAULT_MAX_TOKENS,
            compat: {
              supportsUsageInStreaming: false,
              ...(apiSupportsTools === false ? { supportsTools: false } : {}),
            },
          });
        }
      }

      return models.length > 0 ? models : staticVeniceModelDefinitions();
    } finally {
      await release();
    }
  } catch (error) {
    if (error instanceof VeniceDiscoveryHttpError) {
      log.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
      return staticVeniceModelDefinitions();
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticVeniceModelDefinitions();
  }
}
