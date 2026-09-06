// Ollama plugin entrypoint registers its OpenClaw integration.
import { collectConfiguredModelRefValues } from "@openclaw/model-catalog-core/configured-model-refs";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAppGuidedSetupContext,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderAugmentModelCatalogContext,
  type ProviderCatalogContext,
  type ProviderPlugin,
  type ProviderReplayPolicy,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  coerceSecretRef,
  isNonSecretApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  normalizeResolvedModel,
  resolveThinkingProfile as resolveOllamaThinkingProfile,
} from "./provider-policy-api.js";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_CLOUD_DEFAULT_MODELS,
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_GLM52_CLOUD_MODEL_ID,
  resolveOllamaSetupDefaultBaseUrl,
} from "./src/defaults.js";
import {
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_PROVIDER_ID,
  isLocalOllamaBaseUrl,
  resolveOllamaDiscoveryResult,
  resolveOllamaRuntimeBaseUrl,
  shouldUseSyntheticOllamaAuth,
  type OllamaPluginConfig,
} from "./src/discovery-shared.js";
import {
  createLazyOllamaNodeHostCommands,
  createLazyOllamaNodeInferenceTool,
  createOllamaNodeInvokePolicy,
} from "./src/node-inference-registration.js";
import { readProviderBaseUrl } from "./src/provider-base-url.js";
import {
  buildOllamaModelDefinition,
  buildOllamaProvider,
  buildDefaultOllamaCloudModelDefinition,
  capLocalOllamaModelContext,
  capLocalOllamaProviderContext,
  fetchOllamaModels,
  fetchLoadedOllamaModelNames,
  isOllamaCloudModel,
  queryOllamaModelShowInfo,
  resolveOllamaApiBase,
} from "./src/provider-models.js";
import {
  findAvailableOllamaModelName,
  OLLAMA_APP_GUIDED_MIN_CONTEXT_TOKENS,
  orderPreferredOllamaModelIds,
} from "./src/setup-model-selection.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  resolveConfiguredOllamaProviderConfig,
} from "./src/stream-compat.js";
import { OLLAMA_INCOMPLETE_STREAM_ERROR } from "./src/stream-contract.js";
import { createLazyConfiguredOllamaStreamFn } from "./src/stream-registration.js";
import { createLazyOllamaWebSearchProvider } from "./src/web-search-provider-registration.js";

const loadOllamaSetup = createLazyRuntimeModule(() => import("./src/setup.runtime.js"));
const loadOllamaMemoryEmbeddingProviderAdapter = createLazyRuntimeModule(
  async () =>
    (await import("./src/memory-embedding-adapter.js")).ollamaMemoryEmbeddingProviderAdapter,
);

const lazyOllamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: OLLAMA_PROVIDER_ID,
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: OLLAMA_PROVIDER_ID,
  create: async (options) =>
    await (await loadOllamaMemoryEmbeddingProviderAdapter()).create(options),
};

const ollamaMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: OLLAMA_PROVIDER_ID,
  capabilities: ["image"],
  describeImage: undefined,
  describeImages: undefined,
};

async function checkWsl2CrashLoopRiskLazily(api: OpenClawPluginApi): Promise<void> {
  try {
    const { isWSL2Sync } = await import("openclaw/plugin-sdk/runtime-env");
    if (!isWSL2Sync()) {
      return;
    }
    const { checkWsl2CrashLoopRisk } = await import("./src/wsl2-crash-loop-check.js");
    await checkWsl2CrashLoopRisk(api.logger);
  } catch {
    // Advisory-only startup checks must not break provider registration.
  }
}

function buildNativeOllamaReplayPolicy(): ProviderReplayPolicy {
  return {
    ...buildOpenAICompatibleReplayPolicy("openai-completions", {
      sanitizeToolCallIds: false,
    }),
    sanitizeToolCallIds: false,
  };
}

function matchesOllamaContextOverflowError(errorMessage: string): boolean {
  return (
    /\bollama\b.*(?:context length|too many tokens|context window)/i.test(errorMessage) ||
    /\btruncating input\b.*\btoo long\b/i.test(errorMessage)
  );
}

function classifyOllamaFailoverReason(errorMessage: string): "server_error" | undefined {
  return errorMessage.trim() === OLLAMA_INCOMPLETE_STREAM_ERROR ? "server_error" : undefined;
}

const OLLAMA_CLOUD_DEFAULT_MODEL_REF = `${OLLAMA_CLOUD_PROVIDER_ID}/${OLLAMA_CLOUD_DEFAULT_MODELS[0].id}`;
const OLLAMA_CONFIGURED_SHOW_CONCURRENCY = 4;
const OLLAMA_CONFIGURED_SHOW_MAX_MODELS = 8;

async function buildLocalOllamaProvider(
  configuredBaseUrl?: string,
  opts?: Parameters<typeof buildOllamaProvider>[1],
): Promise<ModelProviderConfig> {
  return capLocalOllamaProviderContext(await buildOllamaProvider(configuredBaseUrl, opts));
}

async function resolveAppGuidedOllamaConnection(ctx: ProviderAppGuidedSetupContext) {
  const pluginConfig = resolvePluginConfigObject(ctx.config, OLLAMA_PROVIDER_ID) as
    | OllamaPluginConfig
    | undefined;
  if (pluginConfig?.discovery?.enabled === false) {
    return null;
  }
  const existing = resolveConfiguredOllamaProviderConfig({
    config: ctx.config,
    providerId: OLLAMA_PROVIDER_ID,
  });
  const accessValue = await resolveAppGuidedOllamaApiKey(ctx, existing);
  const discoveryAccess = accessValue ? { apiKey: accessValue } : {};
  return {
    existing,
    accessValue,
    discoveryAccess,
    baseUrl: resolveOllamaApiBase(
      readProviderBaseUrl(existing) ?? resolveOllamaSetupDefaultBaseUrl(ctx.env),
    ),
  };
}

async function detectAppGuidedOllamaAvailability(
  ctx: ProviderAppGuidedSetupContext,
): Promise<boolean> {
  const connection = await resolveAppGuidedOllamaConnection(ctx);
  if (!connection) {
    return false;
  }
  const result = await fetchOllamaModels(connection.baseUrl, {
    ...connection.discoveryAccess,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  return result.reachable;
}

async function discoverAppGuidedOllamaModel(
  ctx: ProviderAppGuidedSetupContext,
  options?: { modelRef?: string },
) {
  const connection = await resolveAppGuidedOllamaConnection(ctx);
  if (!connection) {
    return null;
  }
  const requestedPrefix = `${OLLAMA_PROVIDER_ID}/`;
  const requestedModelId = options?.modelRef?.startsWith(requestedPrefix)
    ? options.modelRef.slice(requestedPrefix.length)
    : undefined;
  if (options?.modelRef && !requestedModelId) {
    return null;
  }
  const configuredModels = connection.existing?.models ?? [];
  const requestedConfiguredModel = requestedModelId
    ? configuredModels.find(
        (candidate) => findAvailableOllamaModelName(candidate.id, [requestedModelId]) !== undefined,
      )
    : undefined;
  const requestOptions = {
    ...connection.discoveryAccess,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  let availableModelNames: string[];
  if (requestedModelId) {
    if (!requestedConfiguredModel && !isOllamaCloudModel(requestedModelId)) {
      const loaded = await fetchLoadedOllamaModelNames(connection.baseUrl, requestOptions);
      if (
        !loaded.reachable ||
        findAvailableOllamaModelName(requestedModelId, loaded.models) === undefined
      ) {
        return null;
      }
    }
    availableModelNames = [requestedModelId];
  } else {
    // Ambient discovery must not turn an installed-but-idle model into a
    // surprise memory allocation. Only /api/ps owns the resident model set.
    const loaded = await fetchLoadedOllamaModelNames(connection.baseUrl, requestOptions);
    if (!loaded.reachable || loaded.models.length === 0) {
      return null;
    }
    availableModelNames = loaded.models;
  }
  const { models: installedModels } = await fetchOllamaModels(connection.baseUrl, requestOptions);
  // Setup already knows its eligible names. Scanning the general catalog first
  // makes idle models consume its deadline and can hide a resident model past its cap.
  const candidateIds = installedModels
    .filter((candidate) => findAvailableOllamaModelName(candidate.name, availableModelNames))
    .map((candidate) => candidate.name);
  // Hosted routes may use the static definition from explicit cloud setup;
  // local models must still exist in /api/tags before activation.
  const configuredCloudModel =
    requestedConfiguredModel && isOllamaCloudModel(requestedConfiguredModel.id)
      ? requestedConfiguredModel
      : undefined;
  if (configuredCloudModel && !candidateIds.includes(configuredCloudModel.id)) {
    candidateIds.push(configuredCloudModel.id);
  }
  let model: ModelDefinitionConfig | undefined;
  for (const candidateId of orderPreferredOllamaModelIds(candidateIds)) {
    const showInfo = await queryOllamaModelShowInfo(
      connection.baseUrl,
      candidateId,
      requestOptions,
    );
    const contextWindow = showInfo.contextWindow ?? configuredCloudModel?.contextWindow;
    const supportsTools =
      showInfo.capabilities?.includes("tools") ??
      configuredCloudModel?.compat?.supportsTools === true;
    const supportsCompletion =
      showInfo.capabilities?.includes("completion") ?? Boolean(configuredCloudModel);
    if (
      !supportsTools ||
      !supportsCompletion ||
      contextWindow === undefined ||
      contextWindow < OLLAMA_APP_GUIDED_MIN_CONTEXT_TOKENS
    ) {
      continue;
    }
    const definition =
      configuredCloudModel ??
      buildOllamaModelDefinition(candidateId, contextWindow, showInfo.capabilities);
    model = capLocalOllamaModelContext(
      {
        ...definition,
        contextWindow,
        compat: { ...definition.compat, supportsTools: true },
      },
      connection.baseUrl,
    );
    break;
  }
  if (!model) {
    return null;
  }
  const preparedProvider: ModelProviderConfig = {
    baseUrl: connection.baseUrl,
    api: "ollama",
    models: configuredModels.some((candidate) => candidate.id === model.id)
      ? configuredModels.map((candidate) => (candidate.id === model.id ? model : candidate))
      : [...configuredModels, model],
  };
  const ownerValue =
    connection.existing?.apiKey ??
    (connection.accessValue ? "OLLAMA_API_KEY" : OLLAMA_DEFAULT_API_KEY);
  return {
    existing: connection.existing,
    provider: preparedProvider,
    model,
    ownerValue,
  };
}

function hasOllamaDiscoverySignal(providerConfig: ModelProviderConfig | undefined): boolean {
  return (
    Boolean(process.env.OLLAMA_API_KEY?.trim()) ||
    shouldUseSyntheticOllamaAuth(providerConfig) ||
    Boolean(providerConfig?.apiKey)
  );
}

function toDynamicOllamaModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelDefinitionConfig;
}): ProviderRuntimeModel {
  const input = (params.model.input ?? ["text"]).filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  return {
    id: params.model.id,
    name: params.model.name ?? params.model.id,
    provider: params.provider,
    api: params.providerConfig.api ?? "ollama",
    baseUrl: readProviderBaseUrl(params.providerConfig) ?? "",
    reasoning: params.model.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    cost: params.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.model.contextWindow ?? 8192,
    ...(params.model.contextTokens !== undefined
      ? { contextTokens: params.model.contextTokens }
      : {}),
    maxTokens: params.model.maxTokens ?? 8192,
    ...(params.model.compat ? { compat: params.model.compat as never } : {}),
    ...(params.model.params ? { params: params.model.params } : {}),
  };
}

function stripTrailingAuthProfile(raw: string): string {
  const trimmed = raw.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  let delimiter = trimmed.indexOf("@", lastSlash + 1);
  if (delimiter <= 0) {
    return trimmed;
  }
  const suffix = () => trimmed.slice(delimiter + 1);
  if (/^\d{8}(?:@|$)/.test(suffix())) {
    const next = trimmed.indexOf("@", delimiter + 9);
    if (next < 0) {
      return trimmed;
    }
    delimiter = next;
  }
  if (/^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i.test(suffix())) {
    const next = trimmed.indexOf("@", delimiter + 1);
    if (next < 0) {
      return trimmed;
    }
    delimiter = next;
  }
  const model = trimmed.slice(0, delimiter).trim();
  const profile = trimmed.slice(delimiter + 1).trim();
  return model && profile ? model : trimmed;
}

function needsOllamaCatalogMetadata(entry: ProviderAugmentModelCatalogContext["entries"][number]) {
  const hasContextLimit = entry.contextWindow !== undefined || entry.contextTokens !== undefined;
  return (
    !hasContextLimit ||
    entry.reasoning === undefined ||
    entry.input === undefined ||
    entry.compat === undefined
  );
}

function readConfiguredOllamaApiKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value && typeof value === "object" && "value" in value) {
    const resolved = (value as { value?: unknown }).value;
    if (typeof resolved === "string") {
      const trimmed = resolved.trim();
      return trimmed || undefined;
    }
  }
  return undefined;
}

function readConcreteOllamaApiKey(value: unknown): string | undefined {
  if (coerceSecretRef(value)) {
    return undefined;
  }
  const apiKey = readConfiguredOllamaApiKey(value);
  return apiKey && !isNonSecretApiKeyMarker(apiKey) ? apiKey : undefined;
}

async function resolveAppGuidedOllamaApiKey(
  ctx: ProviderAppGuidedSetupContext,
  provider: ModelProviderConfig | undefined,
): Promise<string | undefined> {
  const input = provider?.apiKey;
  if (input === undefined || input === null) {
    const configuredBaseUrl = readProviderBaseUrl(provider);
    if (!configuredBaseUrl || isLocalOllamaBaseUrl(configuredBaseUrl)) {
      return undefined;
    }
    return readConcreteOllamaApiKey(ctx.env.OLLAMA_API_KEY);
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: ctx.config,
    env: ctx.env,
    value: input,
    path: `models.providers.${OLLAMA_PROVIDER_ID}.apiKey`,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.unresolvedRefReason) {
    return undefined;
  }
  const value = readConfiguredOllamaApiKey(resolved.value);
  return value === "OLLAMA_API_KEY"
    ? readConcreteOllamaApiKey(ctx.env.OLLAMA_API_KEY)
    : readConcreteOllamaApiKey(value);
}

function readEnvBackedOllamaApiKey(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const ref = coerceSecretRef(value);
  if (ref?.source === "env") {
    return readConcreteOllamaApiKey(env[ref.id.trim()]);
  }
  return undefined;
}

function isAmbientOllamaApiKeyMarker(value: string | undefined): boolean {
  return value === OLLAMA_DEFAULT_API_KEY || value === "OLLAMA_API_KEY";
}

function readUsableOllamaShowApiKey(params: {
  env: NodeJS.ProcessEnv;
  allowAmbientEnvFallback: boolean;
  explicitApiKey?: unknown;
  resolved?: { apiKey?: unknown; discoveryApiKey?: unknown };
}): string | undefined {
  const explicitEnvApiKey = readEnvBackedOllamaApiKey(params.explicitApiKey, params.env);
  if (explicitEnvApiKey) {
    return explicitEnvApiKey;
  }
  const explicitApiKey = readConcreteOllamaApiKey(params.explicitApiKey);
  if (explicitApiKey) {
    return explicitApiKey;
  }
  const resolvedApiKey = readConfiguredOllamaApiKey(params.resolved?.apiKey);
  const canUseResolvedDiscovery =
    params.allowAmbientEnvFallback || !isAmbientOllamaApiKeyMarker(resolvedApiKey);
  const discoveryApiKey = readConcreteOllamaApiKey(params.resolved?.discoveryApiKey);
  if (discoveryApiKey && canUseResolvedDiscovery) {
    return discoveryApiKey;
  }
  const resolvedEnvApiKey = readEnvBackedOllamaApiKey(params.resolved?.apiKey, params.env);
  if (resolvedEnvApiKey && canUseResolvedDiscovery) {
    return resolvedEnvApiKey;
  }
  const apiKey = readConcreteOllamaApiKey(params.resolved?.apiKey);
  if (apiKey) {
    return apiKey;
  }
  return params.allowAmbientEnvFallback
    ? readConcreteOllamaApiKey(params.env.OLLAMA_API_KEY)
    : undefined;
}

function collectConfiguredOllamaModelIds(params: {
  config?: OpenClawConfig;
  provider: string;
  entries?: ProviderAugmentModelCatalogContext["entries"];
}): Array<{
  id: string;
  api?: ProviderAugmentModelCatalogContext["entries"][number]["api"];
  name?: string;
}> {
  const providerPrefix = `${params.provider.toLowerCase()}/`;
  const models = new Map<
    string,
    {
      id: string;
      api?: ProviderAugmentModelCatalogContext["entries"][number]["api"];
      name?: string;
    }
  >();
  const addModelId = (
    modelId: string,
    api?: ProviderAugmentModelCatalogContext["entries"][number]["api"],
    name?: string,
  ) => {
    const trimmed = modelId.trim();
    if (!trimmed || trimmed === "*") {
      return;
    }
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const existing = models.get(trimmed);
    if (existing) {
      if ((!existing.api && api) || (!existing.name && trimmedName)) {
        models.set(trimmed, {
          ...existing,
          ...(api && !existing.api ? { api } : {}),
          ...(trimmedName && !existing.name ? { name: trimmedName } : {}),
        });
      }
      return;
    }
    models.set(trimmed, {
      id: trimmed,
      ...(api ? { api } : {}),
      ...(trimmedName ? { name: trimmedName } : {}),
    });
  };
  const addRef = (raw: unknown) => {
    if (typeof raw !== "string") {
      return;
    }
    const trimmed = stripTrailingAuthProfile(raw);
    if (!trimmed.toLowerCase().startsWith(providerPrefix)) {
      return;
    }
    const modelId = trimmed.slice(providerPrefix.length).trim();
    addModelId(modelId);
  };

  for (const ref of collectConfiguredModelRefValues(params.config)) {
    addRef(ref);
  }
  for (const entry of params.entries ?? []) {
    if (
      entry.provider.toLowerCase() === params.provider.toLowerCase() &&
      entry.id.trim() &&
      needsOllamaCatalogMetadata(entry)
    ) {
      addModelId(entry.id.trim(), entry.api, entry.name);
    }
  }
  return [...models.values()];
}

function buildStaticOllamaCloudProvider(): ModelProviderConfig {
  return {
    baseUrl: OLLAMA_CLOUD_BASE_URL,
    api: "ollama",
    models: OLLAMA_CLOUD_DEFAULT_MODELS.map(buildDefaultOllamaCloudModelDefinition),
  };
}

async function buildOllamaCloudProvider(apiKey?: string): Promise<ModelProviderConfig> {
  const discovered = await buildOllamaProvider(OLLAMA_CLOUD_BASE_URL, {
    ...(apiKey ? { apiKey } : {}),
    quiet: true,
  });
  if (!discovered.models?.length) {
    return buildStaticOllamaCloudProvider();
  }
  if (!apiKey || discovered.models.some((model) => model.id === OLLAMA_GLM52_CLOUD_MODEL_ID)) {
    return discovered;
  }
  const showInfo = await queryOllamaModelShowInfo(
    OLLAMA_CLOUD_BASE_URL,
    OLLAMA_GLM52_CLOUD_MODEL_ID,
    { apiKey },
  );
  if (typeof showInfo.contextWindow !== "number" && (showInfo.capabilities?.length ?? 0) === 0) {
    return discovered;
  }
  const defaultModel = OLLAMA_CLOUD_DEFAULT_MODELS.find(
    (model) => model.id === OLLAMA_GLM52_CLOUD_MODEL_ID,
  );
  if (!defaultModel) {
    return discovered;
  }
  return {
    ...discovered,
    models: [...discovered.models, buildDefaultOllamaCloudModelDefinition(defaultModel)],
  };
}

async function resolveRequestedDynamicOllamaModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  modelId: string;
  showApiKey?: string;
  capContextTokens?: boolean;
}): Promise<ProviderRuntimeModel | undefined> {
  const showBaseUrl = readProviderBaseUrl(params.providerConfig) ?? OLLAMA_DEFAULT_BASE_URL;
  const showInfo = params.showApiKey
    ? await queryOllamaModelShowInfo(showBaseUrl, params.modelId, { apiKey: params.showApiKey })
    : await queryOllamaModelShowInfo(showBaseUrl, params.modelId);
  if (typeof showInfo.contextWindow !== "number" && (showInfo.capabilities?.length ?? 0) === 0) {
    return undefined;
  }
  const definition = buildOllamaModelDefinition(
    params.modelId,
    showInfo.contextWindow,
    showInfo.capabilities,
  );
  const model = params.capContextTokens
    ? capLocalOllamaModelContext(definition, showBaseUrl)
    : definition;
  return toDynamicOllamaModel({
    provider: params.provider,
    providerConfig: params.providerConfig,
    model,
  });
}

async function augmentConfiguredOllamaCatalogModels(params: {
  config?: OpenClawConfig;
  defaultBaseUrl: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  entries: ProviderAugmentModelCatalogContext["entries"];
  resolveProviderApiKey: ProviderAugmentModelCatalogContext["resolveProviderApiKey"];
  capContextTokens?: boolean;
}): Promise<ProviderAugmentModelCatalogContext["entries"]> {
  const models = collectConfiguredOllamaModelIds({
    config: params.config,
    provider: params.provider,
    entries: params.entries,
  });
  if (models.length === 0) {
    return [];
  }
  const configuredProvider = resolveConfiguredOllamaProviderConfig({
    config: params.config,
    providerId: params.provider,
  });
  const baseUrl = readProviderBaseUrl(configuredProvider) ?? params.defaultBaseUrl;
  const isLocalBaseUrl = isLocalOllamaBaseUrl(baseUrl);
  const showApiKey = readUsableOllamaShowApiKey({
    env: params.env,
    allowAmbientEnvFallback: !isLocalBaseUrl,
    explicitApiKey: configuredProvider?.apiKey,
    resolved: params.resolveProviderApiKey?.(params.provider),
  });
  if (!isLocalBaseUrl && !showApiKey) {
    return [];
  }
  const providerConfig: ModelProviderConfig = {
    ...configuredProvider,
    models: configuredProvider?.models ?? [],
    baseUrl,
    api: configuredProvider?.api ?? "ollama",
  };
  const entries: ProviderAugmentModelCatalogContext["entries"] = [];
  const modelsToProbe = models.slice(0, OLLAMA_CONFIGURED_SHOW_MAX_MODELS);
  for (let index = 0; index < modelsToProbe.length; index += OLLAMA_CONFIGURED_SHOW_CONCURRENCY) {
    const batch = modelsToProbe.slice(index, index + OLLAMA_CONFIGURED_SHOW_CONCURRENCY);
    const rows = await Promise.all(
      batch.map(async (model) => {
        const requested = await resolveRequestedDynamicOllamaModel({
          provider: params.provider,
          providerConfig,
          modelId: model.id,
          showApiKey,
          capContextTokens: params.capContextTokens,
        });
        return requested
          ? {
              id: requested.id,
              name: model.name ?? requested.name,
              provider: requested.provider,
              api: model.api ?? providerConfig.api,
              reasoning: requested.reasoning,
              input: requested.input,
              contextWindow: requested.contextWindow,
              contextTokens: requested.contextTokens,
              compat: requested.compat,
            }
          : undefined;
      }),
    );
    for (const row of rows) {
      if (row) {
        entries.push(row);
      }
    }
  }
  return entries;
}

// Local and cloud own distinct auth/catalog policy but share native transport and replay rules.
const createOllamaSharedProviderHooks = (api: OpenClawPluginApi) =>
  ({
    ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
    createStreamFn: ({ config, model, provider }) => {
      if (model.api !== "ollama") {
        return undefined;
      }
      const { acquireLocalService } = api.runtime.llm;
      const configuredProviderId =
        findNormalizedProviderKey(config?.models?.providers, provider) ?? provider;
      return createLazyConfiguredOllamaStreamFn({
        model,
        localService: { providerId: configuredProviderId, acquire: acquireLocalService },
        providerBaseUrl:
          readProviderBaseUrl(
            resolveConfiguredOllamaProviderConfig({ config, providerId: configuredProviderId }),
          ) ?? (provider === OLLAMA_CLOUD_PROVIDER_ID ? OLLAMA_CLOUD_BASE_URL : undefined),
      });
    },
    buildReplayPolicy: ({ modelApi }) =>
      modelApi === "ollama"
        ? buildNativeOllamaReplayPolicy()
        : buildOpenAICompatibleReplayPolicy(modelApi),
    resolveReasoningOutputMode: () => "native",
    resolveThinkingProfile: resolveOllamaThinkingProfile,
    normalizeResolvedModel,
    wrapStreamFn: createConfiguredOllamaCompatStreamWrapper,
    matchesContextOverflowError: ({ errorMessage }) =>
      matchesOllamaContextOverflowError(errorMessage),
    classifyFailoverReason: ({ errorMessage }) => classifyOllamaFailoverReason(errorMessage),
  }) satisfies Pick<
    ProviderPlugin,
    | "createStreamFn"
    | "normalizeToolSchemas"
    | "inspectToolSchemas"
    | "buildReplayPolicy"
    | "resolveReasoningOutputMode"
    | "resolveThinkingProfile"
    | "normalizeResolvedModel"
    | "wrapStreamFn"
    | "matchesContextOverflowError"
    | "classifyFailoverReason"
  >;

export default definePluginEntry({
  id: "ollama",
  name: "Ollama Provider",
  description: "Bundled Ollama provider plugin",
  register(api: OpenClawPluginApi) {
    const startupPluginConfig = (api.pluginConfig ?? {}) as OllamaPluginConfig;
    const providerHooks = createOllamaSharedProviderHooks(api);
    if (api.registrationMode === "full") {
      void checkWsl2CrashLoopRiskLazily(api);
    }
    api.registerEmbeddingProvider(lazyOllamaMemoryEmbeddingProviderAdapter);
    api.registerMediaUnderstandingProvider(ollamaMediaUnderstandingProvider);
    if (startupPluginConfig.nodeInference?.enabled !== false) {
      for (const command of createLazyOllamaNodeHostCommands()) {
        api.registerNodeHostCommand(command);
      }
    }
    api.registerNodeInvokePolicy(createOllamaNodeInvokePolicy());
    api.registerTool(createLazyOllamaNodeInferenceTool(api));
    const resolveCurrentPluginConfig = (config?: OpenClawConfig): OllamaPluginConfig => {
      const runtimePluginConfig = resolvePluginConfigObject(config, "ollama");
      if (runtimePluginConfig) {
        return runtimePluginConfig as OllamaPluginConfig;
      }
      return config ? {} : startupPluginConfig;
    };
    api.registerWebSearchProvider(createLazyOllamaWebSearchProvider());
    api.registerProvider({
      id: OLLAMA_CLOUD_PROVIDER_ID,
      label: "Ollama Cloud",
      docsPath: "/providers/ollama",
      envVars: ["OLLAMA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: OLLAMA_CLOUD_PROVIDER_ID,
          methodId: "api-key",
          label: "Ollama Cloud API key",
          hint: "Hosted models via ollama.com",
          optionKey: "ollamaCloudApiKey",
          flagName: "--ollama-cloud-api-key",
          envVar: "OLLAMA_API_KEY",
          promptMessage: "Enter Ollama Cloud API key",
          defaultModel: OLLAMA_CLOUD_DEFAULT_MODEL_REF,
          noteTitle: "Ollama Cloud",
          noteMessage: "Manage API keys at https://ollama.com/settings/keys",
          wizard: {
            choiceId: "ollama-cloud",
            choiceLabel: "Ollama Cloud",
            choiceHint: "Hosted models via ollama.com",
            groupId: "ollama",
            groupLabel: "Ollama",
            groupHint: "Cloud and local open models",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx: ProviderCatalogContext) => {
          const resolvedAuth = ctx.resolveProviderApiKey(OLLAMA_CLOUD_PROVIDER_ID);
          const apiKey = resolvedAuth.apiKey ?? resolvedAuth.discoveryApiKey;
          if (!apiKey) {
            return null;
          }
          const discoveryApiKey = readUsableOllamaShowApiKey({
            env: ctx.env,
            allowAmbientEnvFallback: true,
            resolved: resolvedAuth,
          });
          return {
            provider: {
              ...(await buildOllamaCloudProvider(discoveryApiKey)),
              apiKey,
            },
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildStaticOllamaCloudProvider(),
        }),
      },
      ...providerHooks,
      resolveDynamicModel: ({ provider, modelId }) => {
        const cloudProvider = buildStaticOllamaCloudProvider();
        const model = cloudProvider.models?.find((entry) => entry.id === modelId);
        return model
          ? toDynamicOllamaModel({ provider, providerConfig: cloudProvider, model })
          : undefined;
      },
      augmentModelCatalog: async (ctx) =>
        await augmentConfiguredOllamaCatalogModels({
          config: ctx.config,
          defaultBaseUrl: OLLAMA_CLOUD_BASE_URL,
          env: ctx.env,
          provider: OLLAMA_CLOUD_PROVIDER_ID,
          entries: ctx.entries,
          resolveProviderApiKey: ctx.resolveProviderApiKey,
        }),
      buildUnknownModelHint: () =>
        "Ollama Cloud requires an API key. " +
        'Set OLLAMA_API_KEY or run "openclaw onboard --auth-choice ollama-cloud". ' +
        "See: https://docs.openclaw.ai/providers/ollama",
    });
    api.registerProvider({
      id: OLLAMA_PROVIDER_ID,
      label: "Ollama",
      docsPath: "/providers/ollama",
      envVars: ["OLLAMA_API_KEY"],
      auth: [
        {
          id: "local",
          label: "Ollama",
          hint: "Connect to an Ollama server and select a cloud or local model",
          kind: "custom",
          appGuidedSetup: {
            detectAvailability: detectAppGuidedOllamaAvailability,
            detect: async (ctx) => {
              const discovered = await discoverAppGuidedOllamaModel(ctx);
              if (!discovered) {
                return null;
              }
              return {
                modelRef: `${OLLAMA_PROVIDER_ID}/${discovered.model.id}`,
                detail: `${discovered.model.id} at ${discovered.provider.baseUrl}`,
              };
            },
            prepare: async (ctx) => {
              const discovered = await discoverAppGuidedOllamaModel(ctx, {
                modelRef: ctx.modelRef,
              });
              const prefix = `${OLLAMA_PROVIDER_ID}/`;
              if (!discovered || !ctx.modelRef.startsWith(prefix)) {
                return null;
              }
              const modelId = ctx.modelRef.slice(prefix.length);
              if (modelId !== discovered.model.id) {
                return null;
              }
              // Keep discovery ownership explicit so the live probe and persisted
              // route use the same local marker, env marker, or configured input.
              return {
                profiles: [],
                defaultModel: ctx.modelRef,
                configPatch: {
                  models: {
                    mode: ctx.config.models?.mode ?? "merge",
                    providers: {
                      [OLLAMA_PROVIDER_ID]: {
                        ...discovered.existing,
                        ...discovered.provider,
                        ...(discovered.ownerValue ? { apiKey: discovered.ownerValue } : {}),
                        models: discovered.provider.models,
                      },
                    },
                  },
                },
              };
            },
          },
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const { promptAndConfigureOllama } = await loadOllamaSetup();
            const result = await promptAndConfigureOllama({
              cfg: ctx.config,
              env: ctx.env,
              workspaceDir: ctx.workspaceDir,
              opts: ctx.opts as Record<string, unknown> | undefined,
              prompter: ctx.prompter,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              secretInputMode: ctx.secretInputMode,
              allowSecretRefPrompt: ctx.allowSecretRefPrompt,
            });
            return {
              profiles: result.credential
                ? [
                    {
                      profileId: "ollama:default",
                      credential: buildApiKeyCredential(
                        OLLAMA_PROVIDER_ID,
                        result.credential,
                        undefined,
                        result.credentialMode
                          ? {
                              secretInputMode: result.credentialMode,
                              config: ctx.config,
                            }
                          : undefined,
                      ),
                    },
                  ]
                : [],
              configPatch: result.config,
              ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
            };
          },
          validateNonInteractive: async (ctx) =>
            await (await loadOllamaSetup()).validateOllamaNonInteractive(ctx),
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const { configureOllamaNonInteractive } = await loadOllamaSetup();
            return await configureOllamaNonInteractive({
              nextConfig: ctx.config,
              opts: {
                customBaseUrl: ctx.opts.customBaseUrl as string | undefined,
                customModelId: ctx.opts.customModelId as string | undefined,
              },
              runtime: ctx.runtime,
              agentDir: ctx.agentDir,
            });
          },
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx: ProviderCatalogContext) =>
          await resolveOllamaDiscoveryResult({
            ctx,
            pluginConfig: resolveCurrentPluginConfig(ctx.config),
            buildProvider: buildLocalOllamaProvider,
          }),
      },
      wizard: {
        setup: {
          choiceId: "ollama",
          choiceLabel: "Ollama",
          choiceHint: "Connect to an Ollama server and select a cloud or local model",
          groupId: "ollama",
          groupLabel: "Ollama",
          groupHint: "Cloud and local open models",
          methodId: "local",
          modelSelection: {
            promptWhenAuthChoiceProvided: true,
            allowKeepCurrent: false,
          },
        },
        modelPicker: {
          label: "Ollama (custom)",
          hint: "Detect models from a local or remote Ollama instance",
          methodId: "local",
        },
      },
      onModelSelected: async ({ config, model, prompter }) => {
        if (!model.startsWith("ollama/")) {
          return;
        }
        const { ensureOllamaModelPulled } = await loadOllamaSetup();
        await ensureOllamaModelPulled({ config, model, prompter });
      },
      ...providerHooks,
      augmentModelCatalog: async (ctx) =>
        await augmentConfiguredOllamaCatalogModels({
          config: ctx.config,
          defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
          env: ctx.env,
          provider: OLLAMA_PROVIDER_ID,
          entries: ctx.entries,
          resolveProviderApiKey: ctx.resolveProviderApiKey,
          capContextTokens: true,
        }),
      resolveSyntheticAuth: ({ provider, providerConfig }) => {
        if (!shouldUseSyntheticOllamaAuth(providerConfig)) {
          return undefined;
        }
        return {
          apiKey: OLLAMA_DEFAULT_API_KEY,
          source: `models.providers.${provider ?? OLLAMA_PROVIDER_ID} (synthetic local key)`,
          mode: "api-key",
        };
      },
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === OLLAMA_DEFAULT_API_KEY,
      prepareDynamicModel: async (ctx) => {
        const providerConfig = resolveConfiguredOllamaProviderConfig({
          config: ctx.config,
          providerId: ctx.provider,
        });
        if (!hasOllamaDiscoverySignal(providerConfig)) {
          return undefined;
        }
        const baseUrl = readProviderBaseUrl(providerConfig);
        let discoveryApiKey: string | undefined;
        if (providerConfig?.apiKey !== undefined && providerConfig.apiKey !== null) {
          const resolved = await resolveConfiguredSecretInputString({
            config: ctx.config ?? {},
            env: process.env,
            value: providerConfig.apiKey,
            path: `models.providers.${ctx.provider}.apiKey`,
            unresolvedReasonStyle: "detailed",
          });
          if (resolved.unresolvedRefReason) {
            return undefined;
          }
          const resolvedApiKey = readConfiguredOllamaApiKey(resolved.value);
          const configuredSecretRef = coerceSecretRef(providerConfig.apiKey);
          discoveryApiKey = configuredSecretRef
            ? resolvedApiKey
            : resolvedApiKey === "OLLAMA_API_KEY"
              ? readConcreteOllamaApiKey(process.env.OLLAMA_API_KEY)
              : readConcreteOllamaApiKey(resolvedApiKey);
          if (configuredSecretRef && !discoveryApiKey) {
            return undefined;
          }
        } else if (!isLocalOllamaBaseUrl(baseUrl)) {
          discoveryApiKey = readConcreteOllamaApiKey(process.env.OLLAMA_API_KEY);
        }
        const provider = await buildLocalOllamaProvider(baseUrl, {
          quiet: true,
          ...(discoveryApiKey ? { apiKey: discoveryApiKey } : {}),
        });
        const dynamicApi = providerConfig?.api ?? provider.api;
        const dynamicProvider = {
          ...provider,
          baseUrl: resolveOllamaRuntimeBaseUrl({
            api: dynamicApi,
            configuredBaseUrl: baseUrl,
            discoveredBaseUrl: provider.baseUrl,
          }),
          api: dynamicApi,
        };
        const discoveredModel = dynamicProvider.models?.find((model) => model.id === ctx.modelId);
        if (discoveredModel) {
          return toDynamicOllamaModel({
            provider: ctx.provider,
            providerConfig: dynamicProvider,
            model: discoveredModel,
          });
        }
        return await resolveRequestedDynamicOllamaModel({
          provider: ctx.provider,
          providerConfig: dynamicProvider,
          modelId: ctx.modelId,
          showApiKey: discoveryApiKey,
          capContextTokens: true,
        });
      },
      buildUnknownModelHint: () =>
        "Ollama requires authentication to be registered as a provider. " +
        'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/ollama",
    });
  },
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
