import {
  buildConfiguredAllowlistKeys,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../../agents/self-hosted-provider-defaults.js";
import {
  ConfigMutationConflictError,
  readConfigFileSnapshot,
  replaceConfigFile,
  validateConfigObjectWithPlugins,
} from "../../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeHostname } from "../../infra/net/hostname.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildRemoteBaseUrlPolicy } from "../../memory-host-sdk/host/remote-http.js";
import {
  createLazyFacadeValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "../../plugin-sdk/facade-runtime.js";
import {
  fetchLmstudioModels,
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  mapLmstudioWireEntry,
  resolveLmstudioInferenceBase,
  resolveLmstudioRequestContext,
} from "../../plugin-sdk/lmstudio-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { isLoopbackIpAddress } from "../../shared/net/ip.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export type ModelAddAdapter = {
  providerId: string;
  bootstrapMode?: "always" | "discovered";
  bootstrapProviderConfig?: (cfg: OpenClawConfig) => ModelProviderConfig | null;
  detect?: (params: {
    cfg: OpenClawConfig;
    providerConfig: ModelProviderConfig;
    modelId: string;
  }) => Promise<{
    found: boolean;
    model?: ModelDefinitionConfig;
    warnings?: string[];
  }>;
};

type AddModelOutcome = {
  provider: string;
  modelId: string;
  existed: boolean;
  allowlistAdded: boolean;
  warnings: string[];
};

export type ValidateAddProviderResult =
  | { ok: true; provider: string }
  | { ok: false; providers: string[]; knownProvider?: string };

type OllamaModelShowInfo = {
  contextWindow?: number;
  capabilities?: string[];
};

type OllamaApiFacade = {
  buildOllamaModelDefinition: (
    modelId: string,
    contextWindow?: number,
    capabilities?: string[],
  ) => ModelDefinitionConfig;
  queryOllamaModelShowInfo: (apiBase: string, modelName: string) => Promise<OllamaModelShowInfo>;
};

type OpenAIApiFacade = {
  buildOpenAICodexProvider: () => ModelProviderConfig;
  buildOpenAICodexProviderPlugin: () => {
    resolveDynamicModel?: (ctx: {
      provider: string;
      modelId: string;
      modelRegistry: { find: () => null };
    }) => ProviderRuntimeModel | null | undefined;
  };
};

const log = createSubsystemLogger("models-add");
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

function loadOllamaApiFacade(): OllamaApiFacade {
  return loadBundledPluginPublicSurfaceModuleSync<OllamaApiFacade>({
    dirName: "ollama",
    artifactBasename: "api.js",
  });
}

function loadOpenAIApiFacade(): OpenAIApiFacade {
  return loadBundledPluginPublicSurfaceModuleSync<OpenAIApiFacade>({
    dirName: "openai",
    artifactBasename: "api.js",
  });
}

const buildOllamaModelDefinition: OllamaApiFacade["buildOllamaModelDefinition"] =
  createLazyFacadeValue(loadOllamaApiFacade, "buildOllamaModelDefinition");
const queryOllamaModelShowInfo: OllamaApiFacade["queryOllamaModelShowInfo"] = createLazyFacadeValue(
  loadOllamaApiFacade,
  "queryOllamaModelShowInfo",
);
const buildOpenAICodexProvider: OpenAIApiFacade["buildOpenAICodexProvider"] = createLazyFacadeValue(
  loadOpenAIApiFacade,
  "buildOpenAICodexProvider",
);
const buildOpenAICodexProviderPlugin: OpenAIApiFacade["buildOpenAICodexProviderPlugin"] =
  createLazyFacadeValue(loadOpenAIApiFacade, "buildOpenAICodexProviderPlugin");

function sanitizeUrlForLogs(raw: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid_url]";
  }
}

function buildDefaultModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: SELF_HOSTED_DEFAULT_COST,
    contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
    maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
  };
}

function buildOpenAICodexModelDefinition(modelId: string): ModelDefinitionConfig {
  const dynamicModel = buildOpenAICodexProviderPlugin().resolveDynamicModel?.({
    provider: "openai-codex",
    modelId,
    modelRegistry: { find: () => null },
  });
  if (dynamicModel) {
    return {
      id: dynamicModel.id,
      name: dynamicModel.name,
      api: "openai-codex-responses",
      baseUrl: dynamicModel.baseUrl,
      reasoning: dynamicModel.reasoning,
      input: [...dynamicModel.input],
      cost: dynamicModel.cost,
      contextWindow: dynamicModel.contextWindow,
      ...(dynamicModel.contextTokens ? { contextTokens: dynamicModel.contextTokens } : {}),
      maxTokens: dynamicModel.maxTokens,
      ...(dynamicModel.headers ? { headers: dynamicModel.headers } : {}),
      ...(dynamicModel.compat ? { compat: dynamicModel.compat } : {}),
      metadataSource: "models-add",
    };
  }
  return {
    id: modelId,
    name: modelId,
    api: "openai-codex-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
    maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    metadataSource: "models-add",
  };
}

function resolveConfiguredProvider(
  cfg: OpenClawConfig,
  providerId: string,
): { providerKey: string; providerConfig: ModelProviderConfig } | undefined {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  const providers = cfg.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [configuredProviderId, configuredProvider] of Object.entries(providers)) {
    if (normalizeProviderId(configuredProviderId) === normalizedProviderId) {
      return {
        providerKey: configuredProviderId,
        providerConfig: configuredProvider,
      };
    }
  }
  return undefined;
}

function buildDefaultLmstudioProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: resolveLmstudioInferenceBase(LMSTUDIO_DEFAULT_INFERENCE_BASE_URL),
    api: "openai-completions",
    auth: "api-key",
    apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    models: [],
  };
}

function isLocalLmstudioBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = normalizeOptionalString(baseUrl);
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return (
      hostname === "localhost" ||
      hostname === "localhost.localdomain" ||
      isLoopbackIpAddress(hostname)
    );
  } catch {
    return false;
  }
}

const MODEL_ADD_ADAPTERS: Record<string, ModelAddAdapter> = {
  "openai-codex": {
    providerId: "openai-codex",
    bootstrapMode: "discovered",
    bootstrapProviderConfig: () => ({
      ...buildOpenAICodexProvider(),
      models: [],
    }),
    detect: async ({ modelId }) => ({
      found: true,
      model: buildOpenAICodexModelDefinition(modelId),
      warnings: [
        "OpenAI Codex model metadata was saved from provider defaults; provider availability still depends on your Codex account.",
      ],
    }),
  },
  ollama: {
    providerId: "ollama",
    bootstrapProviderConfig: () => ({
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      api: "ollama",
      apiKey: "ollama-local",
      models: [],
    }),
    detect: async ({ providerConfig, modelId }) => {
      const info = (await queryOllamaModelShowInfo(providerConfig.baseUrl, modelId)) ?? {};
      return {
        found: typeof info.contextWindow === "number" || (info.capabilities?.length ?? 0) > 0,
        model: buildOllamaModelDefinition(modelId, info.contextWindow, info.capabilities),
      };
    },
  },
  lmstudio: {
    providerId: "lmstudio",
    bootstrapProviderConfig: () => buildDefaultLmstudioProviderConfig(),
    detect: async ({ cfg, providerConfig, modelId }) => {
      if (!isLocalLmstudioBaseUrl(providerConfig.baseUrl)) {
        return {
          found: false,
          warnings: [
            "LM Studio metadata detection is limited to local baseUrl values; using defaults.",
          ],
        };
      }
      try {
        const { apiKey, headers } = await resolveLmstudioRequestContext({
          config: {
            ...cfg,
            models: {
              ...cfg.models,
              providers: {
                ...cfg.models?.providers,
                lmstudio: providerConfig,
              },
            },
          },
          env: process.env,
          providerHeaders: providerConfig.headers,
        });
        const fetched = await fetchLmstudioModels({
          baseUrl: providerConfig.baseUrl,
          apiKey,
          headers,
          ssrfPolicy: buildRemoteBaseUrlPolicy(providerConfig.baseUrl),
        });
        const match = fetched.models.find(
          (entry) => normalizeOptionalString(entry.key) === modelId,
        );
        const base = match ? mapLmstudioWireEntry(match) : null;
        if (!base) {
          return { found: false };
        }
        return {
          found: true,
          model: {
            id: base.id,
            name: base.displayName,
            reasoning: base.reasoning,
            input: base.input,
            cost: base.cost,
            contextWindow: base.contextWindow,
            contextTokens: base.contextTokens,
            maxTokens: base.maxTokens,
          },
        };
      } catch (error) {
        log.warn("lmstudio model metadata detection failed; using defaults", {
          baseUrl: sanitizeUrlForLogs(providerConfig.baseUrl),
          modelId,
          error: formatErrorMessage(error),
        });
        return {
          found: false,
          warnings: ["LM Studio metadata detection failed; using defaults."],
        };
      }
    },
  },
};

function canAddProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  allowDiscoveredBootstrap?: boolean;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return false;
  }
  if (resolveConfiguredProvider(params.cfg, provider)) {
    return true;
  }
  const adapter = MODEL_ADD_ADAPTERS[provider];
  if (!adapter?.bootstrapProviderConfig) {
    return false;
  }
  if (adapter.bootstrapMode === "discovered" && !params.allowDiscoveredBootstrap) {
    return false;
  }
  return !!adapter.bootstrapProviderConfig(params.cfg);
}

export function listAddableProviders(params: {
  cfg: OpenClawConfig;
  discoveredProviders?: readonly string[];
}): string[] {
  const providers = new Set<string>();
  for (const provider of params.discoveredProviders ?? []) {
    const normalized = normalizeProviderId(provider);
    if (
      normalized &&
      canAddProvider({
        cfg: params.cfg,
        provider: normalized,
        allowDiscoveredBootstrap: true,
      })
    ) {
      providers.add(normalized);
    }
  }
  for (const provider of Object.keys(params.cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(provider);
    if (normalized) {
      providers.add(normalized);
    }
  }
  for (const [provider, adapter] of Object.entries(MODEL_ADD_ADAPTERS)) {
    if (adapter.bootstrapMode !== "discovered") {
      providers.add(provider);
    }
  }
  return [...providers].toSorted();
}

export function validateAddProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  discoveredProviders?: readonly string[];
}): ValidateAddProviderResult {
  const provider = normalizeProviderId(params.provider);
  const providers = listAddableProviders({
    cfg: params.cfg,
    discoveredProviders: params.discoveredProviders,
  });
  if (!provider || !providers.includes(provider)) {
    const knownProvider = (params.discoveredProviders ?? [])
      .map((discoveredProvider) => normalizeProviderId(discoveredProvider))
      .find((discoveredProvider) => discoveredProvider === provider);
    return { ok: false, providers, ...(knownProvider ? { knownProvider } : {}) };
  }
  return { ok: true, provider };
}

function ensureProviderConfig(params: { cfg: OpenClawConfig; provider: string }):
  | {
      ok: true;
      providerKey: string;
      providerConfig: ModelProviderConfig;
      bootstrapped: boolean;
    }
  | { ok: false } {
  const configuredProvider = resolveConfiguredProvider(params.cfg, params.provider);
  if (configuredProvider) {
    return {
      ok: true,
      providerKey: configuredProvider.providerKey,
      providerConfig: configuredProvider.providerConfig,
      bootstrapped: false,
    };
  }
  const bootstrapped = MODEL_ADD_ADAPTERS[params.provider]?.bootstrapProviderConfig?.(params.cfg);
  if (!bootstrapped) {
    return { ok: false };
  }
  return {
    ok: true,
    providerKey: params.provider,
    providerConfig: bootstrapped,
    bootstrapped: true,
  };
}

async function detectModelDefinition(params: {
  cfg: OpenClawConfig;
  provider: string;
  providerConfig: ModelProviderConfig;
  modelId: string;
}): Promise<{ model: ModelDefinitionConfig; warnings: string[] }> {
  const adapter = MODEL_ADD_ADAPTERS[params.provider];
  if (!adapter?.detect) {
    return {
      model: buildDefaultModelDefinition(params.modelId),
      warnings: ["Model metadata could not be auto-detected; saved with default capabilities."],
    };
  }
  const detected = await adapter.detect(params);
  if (detected.found && detected.model) {
    return {
      model: detected.model,
      warnings: detected.warnings ?? [],
    };
  }
  return {
    model: buildDefaultModelDefinition(params.modelId),
    warnings: [
      ...(detected.warnings ?? []),
      "Model metadata could not be auto-detected; saved with default capabilities.",
    ],
  };
}

export async function detectProviderModelDefinition(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): Promise<{
  supported: boolean;
  found: boolean;
  model?: ModelDefinitionConfig;
  warnings: string[];
}> {
  const provider = normalizeProviderId(params.provider);
  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!provider || !modelId) {
    return { supported: false, found: false, warnings: [] };
  }
  const adapter = MODEL_ADD_ADAPTERS[provider];
  if (!adapter?.detect) {
    return { supported: false, found: false, warnings: [] };
  }
  const providerResolution = ensureProviderConfig({
    cfg: params.cfg,
    provider,
  });
  if (!providerResolution.ok) {
    return { supported: true, found: false, warnings: [] };
  }
  const detected = await adapter.detect({
    cfg: params.cfg,
    providerConfig: providerResolution.providerConfig,
    modelId,
  });
  return {
    supported: true,
    found: detected.found && !!detected.model,
    model: detected.model,
    warnings: detected.warnings ?? [],
  };
}

function upsertModelEntry(params: {
  cfg: OpenClawConfig;
  provider: string;
  providerKey: string;
  providerConfig: ModelProviderConfig;
  model: ModelDefinitionConfig;
}): { nextConfig: OpenClawConfig; existed: boolean } {
  const nextConfig = structuredClone(params.cfg);
  nextConfig.models ??= {};
  nextConfig.models.providers ??= {};
  const existingProvider = nextConfig.models.providers[params.providerKey];
  const providerConfig = existingProvider
    ? {
        ...existingProvider,
        models: Array.isArray(existingProvider.models) ? [...existingProvider.models] : [],
      }
    : {
        ...params.providerConfig,
        models: Array.isArray(params.providerConfig.models)
          ? [...params.providerConfig.models]
          : [],
      };
  const modelKey = normalizeLowercaseStringOrEmpty(params.model.id);
  const existingIndex = providerConfig.models.findIndex(
    (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === modelKey,
  );
  const existed = existingIndex !== -1;
  if (!existed) {
    providerConfig.models.push(params.model);
  }
  nextConfig.models.providers[params.providerKey] = providerConfig;
  return { nextConfig, existed };
}

function maybeAddAllowlistEntry(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): { nextConfig: OpenClawConfig; added: boolean } {
  const allowlistKeys = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: resolveDefaultModelForAgent({ cfg: params.cfg }).provider,
  });
  if (!allowlistKeys || allowlistKeys.size === 0) {
    return { nextConfig: params.cfg, added: false };
  }
  const rawRef = `${params.provider}/${params.modelId}`;
  const resolved = resolveModelRefFromString({
    raw: rawRef,
    defaultProvider: resolveDefaultModelForAgent({ cfg: params.cfg }).provider,
  });
  if (!resolved) {
    return { nextConfig: params.cfg, added: false };
  }
  const normalizedKey = `${resolved.ref.provider}/${resolved.ref.model}`.toLowerCase();
  if (allowlistKeys.has(normalizedKey)) {
    return { nextConfig: params.cfg, added: false };
  }
  const nextConfig = structuredClone(params.cfg);
  nextConfig.agents ??= {};
  nextConfig.agents.defaults ??= {};
  nextConfig.agents.defaults.models ??= {};
  nextConfig.agents.defaults.models[`${params.provider}/${params.modelId}`] = {};
  return { nextConfig, added: true };
}

export async function addModelToConfig(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): Promise<{ ok: true; result: AddModelOutcome } | { ok: false; error: string }> {
  const provider = normalizeProviderId(params.provider);
  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!provider || !modelId) {
    return { ok: false, error: "Provider and model id are required." };
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return { ok: false, error: "Config file is invalid; fix it before using /models add." };
  }

  const currentConfig = structuredClone(snapshot.parsed as OpenClawConfig);
  const providerResolution = ensureProviderConfig({
    cfg: currentConfig,
    provider,
  });
  if (!providerResolution.ok) {
    return {
      ok: false,
      error: `Provider "${provider}" is not configured for custom models yet. Configure the provider first, then retry /models add.`,
    };
  }

  const detected = await detectModelDefinition({
    cfg: currentConfig,
    provider,
    providerConfig: providerResolution.providerConfig,
    modelId,
  });
  const upserted = upsertModelEntry({
    cfg: currentConfig,
    provider,
    providerKey: providerResolution.providerKey,
    providerConfig: providerResolution.providerConfig,
    model: detected.model,
  });
  const allowlisted = maybeAddAllowlistEntry({
    cfg: upserted.nextConfig,
    provider,
    modelId,
  });

  const changed = !upserted.existed || allowlisted.added || providerResolution.bootstrapped;
  if (!changed) {
    return {
      ok: true,
      result: {
        provider,
        modelId,
        existed: true,
        allowlistAdded: false,
        warnings: detected.warnings,
      },
    };
  }

  const validated = validateConfigObjectWithPlugins(allowlisted.nextConfig);
  if (!validated.ok) {
    const issue = validated.issues[0];
    const detail = issue ? `${issue.path}: ${issue.message}` : "unknown validation error";
    return {
      ok: false,
      error: `Config invalid after /models add (${detail}).`,
    };
  }

  try {
    await replaceConfigFile({
      nextConfig: validated.config,
      ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigMutationConflictError) {
      return {
        ok: false,
        error: "Config changed while /models add was running. Retry the command.",
      };
    }
    throw error;
  }
  return {
    ok: true,
    result: {
      provider,
      modelId,
      existed: upserted.existed,
      allowlistAdded: allowlisted.added,
      warnings: detected.warnings,
    },
  };
}
