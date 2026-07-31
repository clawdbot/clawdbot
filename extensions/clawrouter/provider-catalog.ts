// ClawRouter provider catalog maps credential-scoped routes to OpenClaw transports.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const CLAWROUTER_DEFAULT_BASE_URL = "https://clawrouter.openclaw.ai";

const PROVIDER_ID = "clawrouter";
const CATALOG_CACHE_TTL_MS = 60_000;
const ROUTE_METADATA_KEY = "clawrouterRoute";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type CatalogRoute = {
  path: string;
  requestFormat: string;
  methods: string[];
};

type CatalogPricing = {
  inputMicrosPerMillion?: number;
  outputMicrosPerMillion?: number;
  cachedInputMicrosPerMillion?: number;
  cacheWrite5mInputMicrosPerMillion?: number;
  cacheWrite1hInputMicrosPerMillion?: number;
  maxInputTokens?: number;
  defaultMaxOutputTokens?: number;
};

type CatalogModel = {
  id: string;
  upstream: string;
  capabilities: string[];
  pricing?: CatalogPricing;
};

type CatalogProvider = {
  id: string;
  displayName: string;
  openaiCompatible: boolean;
  nativeBaseUrl: string;
  routes: CatalogRoute[];
  models: CatalogModel[];
};

type RouteMetadata = {
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  upstreamModel?: string;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readPositiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function readCatalogRows(body: unknown): readonly unknown[] {
  const providers = readRecord(body)?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("ClawRouter catalog response must contain providers[]");
  }
  return providers;
}

function parseCatalogRoute(value: unknown): CatalogRoute | undefined {
  const row = readRecord(value);
  const path = readString(row?.path);
  const requestFormat = readString(row?.requestFormat);
  if (!path || !requestFormat) {
    return undefined;
  }
  return {
    path,
    requestFormat,
    methods: readStringArray(row?.methods).map((method) => method.toUpperCase()),
  };
}

function parseCatalogPricing(value: unknown): CatalogPricing | undefined {
  const row = readRecord(value);
  if (!row) {
    return undefined;
  }
  return {
    inputMicrosPerMillion: readNonNegativeNumber(row.inputMicrosPerMillion),
    outputMicrosPerMillion: readNonNegativeNumber(row.outputMicrosPerMillion),
    cachedInputMicrosPerMillion: readNonNegativeNumber(row.cachedInputMicrosPerMillion),
    cacheWrite5mInputMicrosPerMillion: readNonNegativeNumber(row.cacheWrite5mInputMicrosPerMillion),
    cacheWrite1hInputMicrosPerMillion: readNonNegativeNumber(row.cacheWrite1hInputMicrosPerMillion),
    maxInputTokens: readPositiveSafeInteger(row.maxInputTokens),
    defaultMaxOutputTokens: readPositiveSafeInteger(row.defaultMaxOutputTokens),
  };
}

function parseCatalogModel(value: unknown): CatalogModel | undefined {
  const row = readRecord(value);
  const id = readString(row?.id);
  const upstream = readString(row?.upstream);
  if (!id || !upstream) {
    return undefined;
  }
  return {
    id,
    upstream,
    capabilities: readStringArray(row?.capabilities),
    pricing: parseCatalogPricing(row?.pricing),
  };
}

function parseCatalogProvider(value: unknown): CatalogProvider | undefined {
  const row = readRecord(value);
  const id = readString(row?.id);
  const nativeBaseUrl = readString(row?.nativeBaseUrl);
  if (!id || !nativeBaseUrl || !nativeBaseUrl.startsWith("/v1/native/")) {
    return undefined;
  }
  return {
    id,
    displayName: readString(row?.displayName) ?? id,
    openaiCompatible: row?.openaiCompatible === true,
    nativeBaseUrl,
    routes: Array.isArray(row?.routes)
      ? row.routes.map(parseCatalogRoute).filter((route): route is CatalogRoute => Boolean(route))
      : [],
    models: Array.isArray(row?.models)
      ? row.models.map(parseCatalogModel).filter((model): model is CatalogModel => Boolean(model))
      : [],
  };
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeClawRouterRootUrl(baseUrl: string | undefined): string {
  const normalized = trimTrailingSlashes(baseUrl?.trim() || CLAWROUTER_DEFAULT_BASE_URL);
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

export function normalizeClawRouterApiBaseUrl(baseUrl: string | undefined): string {
  return `${normalizeClawRouterRootUrl(baseUrl)}/v1`;
}

function supportsCapability(model: CatalogModel, ...capabilities: string[]): boolean {
  return capabilities.some((capability) => model.capabilities.includes(capability));
}

function findNativeRoute(
  provider: CatalogProvider,
  requestFormat: string,
): CatalogRoute | undefined {
  return provider.routes.find(
    (route) => route.methods.includes("POST") && route.requestFormat === requestFormat,
  );
}

function googleNativeBaseUrl(rootUrl: string, provider: CatalogProvider, route: CatalogRoute) {
  const modelPathIndex = route.path.indexOf("/models/${model}");
  if (modelPathIndex <= 0) {
    return undefined;
  }
  return `${rootUrl}${provider.nativeBaseUrl}${route.path.slice(0, modelPathIndex)}`;
}

function inferReasoning(providerId: string, modelId: string): boolean {
  const id = `${providerId}/${modelId}`.toLowerCase();
  return /(?:claude-|gemini-|gpt-5|gpt-oss|deepseek-v|reasoner|glm-5|grok-4|minimax-m)/u.test(id);
}

function inferInput(providerId: string, modelId: string): Array<"text" | "image"> {
  const id = `${providerId}/${modelId}`.toLowerCase();
  return /(?:claude-|gemini-|gpt-4o|gpt-5)/u.test(id) ? ["text", "image"] : ["text"];
}

function microsPerMillionToCost(value: number | undefined): number {
  return value === undefined ? 0 : value / 1_000_000;
}

function modelCost(pricing: CatalogPricing | undefined): ModelDefinitionConfig["cost"] {
  if (!pricing) {
    return DEFAULT_COST;
  }
  return {
    input: microsPerMillionToCost(pricing.inputMicrosPerMillion),
    output: microsPerMillionToCost(pricing.outputMicrosPerMillion),
    cacheRead: microsPerMillionToCost(pricing.cachedInputMicrosPerMillion),
    cacheWrite: microsPerMillionToCost(
      pricing.cacheWrite5mInputMicrosPerMillion ?? pricing.cacheWrite1hInputMicrosPerMillion,
    ),
  };
}

function buildRoutedModel(
  rootUrl: string,
  provider: CatalogProvider,
  model: CatalogModel,
): ModelDefinitionConfig | undefined {
  let api: NonNullable<ModelDefinitionConfig["api"]>;
  let baseUrl: string;
  let upstreamModel: string | undefined;

  if (provider.openaiCompatible && supportsCapability(model, "llm.responses")) {
    api = "openai-responses";
    baseUrl = `${rootUrl}/v1`;
  } else if (provider.openaiCompatible && supportsCapability(model, "llm.chat")) {
    api = "openai-completions";
    baseUrl = `${rootUrl}/v1`;
  } else if (
    supportsCapability(model, "llm.messages") &&
    findNativeRoute(provider, "anthropic.messages")
  ) {
    api = "anthropic-messages";
    baseUrl = `${rootUrl}${provider.nativeBaseUrl}`;
    upstreamModel = model.upstream;
  } else {
    const googleRoute =
      supportsCapability(model, "llm.stream") &&
      provider.routes.find(
        (route) =>
          route.methods.includes("POST") &&
          route.requestFormat === "google.generate_content" &&
          route.path.includes(":streamGenerateContent"),
      );
    const googleBaseUrl = googleRoute
      ? googleNativeBaseUrl(rootUrl, provider, googleRoute)
      : undefined;
    if (!googleBaseUrl) {
      return undefined;
    }
    api = "google-generative-ai";
    baseUrl = googleBaseUrl;
    upstreamModel = model.upstream;
  }

  return {
    id: model.id,
    name: `${provider.displayName} · ${model.id}`,
    api,
    baseUrl,
    reasoning: inferReasoning(provider.id, model.id),
    input: inferInput(provider.id, model.id),
    cost: modelCost(model.pricing),
    contextWindow: model.pricing?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.pricing?.defaultMaxOutputTokens ?? DEFAULT_MAX_TOKENS,
    params: {
      [ROUTE_METADATA_KEY]: {
        api,
        baseUrl,
        ...(upstreamModel ? { upstreamModel } : {}),
      } satisfies RouteMetadata,
    },
  };
}

function buildDiscoveredModels(
  rootUrl: string,
  providers: CatalogProvider[],
): ModelDefinitionConfig[] {
  const models = new Map<string, ModelDefinitionConfig>();
  for (const provider of providers) {
    for (const model of provider.models) {
      const routed = buildRoutedModel(rootUrl, provider, model);
      if (!routed || models.has(routed.id)) {
        continue;
      }
      models.set(routed.id, routed);
    }
  }
  return [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export async function buildClawRouterProviderConfig(params: {
  apiKey: string;
  discoveryApiKey?: string;
  baseUrl?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  const rootUrl = normalizeClawRouterRootUrl(params.baseUrl);
  const rows = await getCachedLiveProviderModelRows({
    providerId: PROVIDER_ID,
    endpoint: `${rootUrl}/v1/catalog`,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    readRows: readCatalogRows,
    ttlMs: CATALOG_CACHE_TTL_MS,
    shouldCacheRows: (providers) => providers.length > 0,
    auditContext: "clawrouter-model-discovery",
  });
  const providers = rows
    .map(parseCatalogProvider)
    .filter((provider): provider is CatalogProvider => Boolean(provider));
  return {
    baseUrl: `${rootUrl}/v1`,
    api: "openai-responses",
    apiKey: params.apiKey,
    models: buildDiscoveredModels(rootUrl, providers),
  };
}

function readRouteMetadata(params: ProviderRuntimeModel["params"]): RouteMetadata | undefined {
  const row = readRecord(params?.[ROUTE_METADATA_KEY]);
  const baseUrl = readString(row?.baseUrl);
  const api = readString(row?.api);
  if (
    !baseUrl ||
    (api !== "openai-responses" &&
      api !== "openai-completions" &&
      api !== "anthropic-messages" &&
      api !== "google-generative-ai")
  ) {
    return undefined;
  }
  const upstreamModel = readString(row?.upstreamModel);
  return {
    api,
    baseUrl,
    ...(upstreamModel ? { upstreamModel } : {}),
  };
}

function stripRouteMetadata(
  params: ProviderRuntimeModel["params"],
): ProviderRuntimeModel["params"] {
  if (!params || !(ROUTE_METADATA_KEY in params)) {
    return params;
  }
  const { [ROUTE_METADATA_KEY]: _routeMetadata, ...remaining } = params;
  return Object.keys(remaining).length > 0 ? remaining : undefined;
}

export function normalizeClawRouterResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  const route = readRouteMetadata(model.params);
  if (!route) {
    return undefined;
  }
  return {
    ...model,
    api: route.api,
    baseUrl: route.baseUrl,
  };
}

export function prepareClawRouterRequestModel(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const route = readRouteMetadata(model.params);
  if (!route) {
    return model;
  }
  return {
    ...model,
    params: stripRouteMetadata(model.params),
    ...(route.upstreamModel && route.upstreamModel !== model.id ? { id: route.upstreamModel } : {}),
  };
}
