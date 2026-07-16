import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";
import {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  resolveOllamaApiBase,
} from "./src/provider-models.js";

const PROVIDER_ID = "ollama";
const DEFAULT_API_KEY = "ollama-local";
const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;

type OllamaPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

type OllamaProviderLikeConfig = ModelProviderConfig;
type OllamaProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  envVars: string[];
  auth: [];
  discovery: {
    order: "late";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runOllamaDiscovery>;
  };
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (value && typeof value === "object" && "value" in value) {
    return normalizeOptionalString((value as { value?: unknown }).value);
  }
  return undefined;
}

function resolveOllamaDiscoveryApiKey(params: {
  env: NodeJS.ProcessEnv;
  explicitApiKey?: string;
  resolvedApiKey?: string;
}): string {
  const envApiKey = params.env.OLLAMA_API_KEY?.trim() ? "OLLAMA_API_KEY" : undefined;
  return envApiKey ?? params.explicitApiKey ?? params.resolvedApiKey ?? DEFAULT_API_KEY;
}

function shouldSkipAmbientOllamaDiscovery(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

function hasMeaningfulExplicitOllamaConfig(
  providerConfig: OllamaProviderLikeConfig | undefined,
): boolean {
  if (!providerConfig) {
    return false;
  }
  if (Array.isArray(providerConfig.models) && providerConfig.models.length > 0) {
    return true;
  }
  if (typeof providerConfig.baseUrl === "string" && providerConfig.baseUrl.trim()) {
    return resolveOllamaApiBase(providerConfig.baseUrl) !== OLLAMA_DEFAULT_BASE_URL;
  }
  if (readStringValue(providerConfig.apiKey)) {
    return true;
  }
  if (providerConfig.auth) {
    return true;
  }
  if (typeof providerConfig.authHeader === "boolean") {
    return true;
  }
  if (
    providerConfig.headers &&
    typeof providerConfig.headers === "object" &&
    Object.keys(providerConfig.headers).length > 0
  ) {
    return true;
  }
  if (providerConfig.request) {
    return true;
  }
  if (typeof providerConfig.injectNumCtxForOpenAICompat === "boolean") {
    return true;
  }
  return false;
}

async function buildOllamaProvider(
  configuredBaseUrl?: string,
  opts?: { quiet?: boolean },
): Promise<ModelProviderConfig> {
  const apiBase = resolveOllamaApiBase(configuredBaseUrl);
  const { reachable, models } = await fetchOllamaModels(apiBase);
  if (!reachable && !opts?.quiet) {
    console.warn(`Ollama could not be reached at ${apiBase}.`);
  }
  const discovered = await enrichOllamaModelsWithContext(
    apiBase,
    models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT),
  );
  return {
    baseUrl: apiBase,
    api: "ollama",
    models: discovered.map((model) =>
      buildOllamaModelDefinition(model.name, model.contextWindow, model.capabilities),
    ),
  };
}

function resolveOllamaPluginConfig(ctx: ProviderCatalogContext): OllamaPluginConfig {
  const entries = (ctx.config.plugins?.entries ?? {}) as Record<
    string,
    { config?: OllamaPluginConfig }
  >;
  return entries.ollama?.config ?? {};
}

async function runOllamaDiscovery(ctx: ProviderCatalogContext) {
  const pluginConfig = resolveOllamaPluginConfig(ctx);
  const explicit = ctx.config.models?.providers?.ollama;
  const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
  const hasMeaningfulExplicitConfig = hasMeaningfulExplicitOllamaConfig(explicit);
  const discoveryEnabled =
    pluginConfig.discovery?.enabled ?? ctx.config.models?.ollamaDiscovery?.enabled;
  if (!hasExplicitModels && discoveryEnabled === false) {
    return null;
  }
  const ollamaKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
  const hasRealOllamaKey =
    typeof ollamaKey === "string" &&
    ollamaKey.trim().length > 0 &&
    ollamaKey.trim() !== DEFAULT_API_KEY;
  const explicitApiKey = readStringValue(explicit?.apiKey);
  if (hasExplicitModels && explicit) {
    return {
      provider: {
        ...explicit,
        baseUrl:
          typeof explicit.baseUrl === "string" && explicit.baseUrl.trim()
            ? resolveOllamaApiBase(explicit.baseUrl)
            : OLLAMA_DEFAULT_BASE_URL,
        api: explicit.api ?? "ollama",
        apiKey: resolveOllamaDiscoveryApiKey({
          env: ctx.env,
          explicitApiKey,
          resolvedApiKey: ollamaKey,
        }),
      },
    };
  }
  if (
    !hasRealOllamaKey &&
    !hasMeaningfulExplicitConfig &&
    shouldSkipAmbientOllamaDiscovery(ctx.env)
  ) {
    return null;
  }

  const provider = await buildOllamaProvider(explicit?.baseUrl, {
    quiet: !hasRealOllamaKey && !hasMeaningfulExplicitConfig,
  });
  if (provider.models?.length === 0 && !ollamaKey && !explicit?.apiKey) {
    return null;
  }
  return {
    provider: {
      ...provider,
      apiKey: resolveOllamaDiscoveryApiKey({
        env: ctx.env,
        explicitApiKey,
        resolvedApiKey: ollamaKey,
      }),
    },
  };
}

export const ollamaProviderDiscovery: OllamaProviderPlugin = {
  id: PROVIDER_ID,
  label: "Ollama",
  docsPath: "/providers/ollama",
  envVars: ["OLLAMA_API_KEY"],
  auth: [],
  discovery: {
    order: "late",
    run: runOllamaDiscovery,
  },
};

export default ollamaProviderDiscovery;
