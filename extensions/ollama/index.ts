// Ollama plugin entrypoint registers its OpenClaw integration.
import { collectConfiguredModelRefValues } from "@openclaw/model-catalog-core/configured-model-refs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderAugmentModelCatalogContext,
  type ProviderCatalogContext,
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
import {
  buildOpenAICompatibleReplayPolicy,
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildOllamaModelDefinition,
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
  queryOllamaModelShowInfo,
} from "./api.js";
import { resolveThinkingProfile as resolveOllamaThinkingProfile } from "./provider-policy-api.js";
import {
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_CLOUD_DEFAULT_MODELS,
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_DEFAULT_BASE_URL,
} from "./src/defaults.js";
import {
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_PROVIDER_ID,
  isLocalOllamaBaseUrl,
  resolveOllamaDiscoveryResult,
  shouldUseSyntheticOllamaAuth,
  type OllamaPluginConfig,
} from "./src/discovery-shared.js";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./src/embedding-provider.js";
import { ollamaMediaUnderstandingProvider } from "./src/media-understanding-provider.js";
import { ollamaMemoryEmbeddingProviderAdapter } from "./src/memory-embedding-adapter.js";
import { readProviderBaseUrl } from "./src/provider-base-url.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
  resolveConfiguredOllamaProviderConfig,
} from "./src/stream.js";
import { createOllamaWebSearchProvider } from "./src/web-search-provider.js";
import { checkWsl2CrashLoopRisk } from "./src/wsl2-crash-loop-check.js";

function buildNativeOllamaReplayPolicy(): ProviderReplayPolicy {
  return {
    ...buildOpenAICompatibleReplayPolicy("openai-completions", {
      sanitizeToolCallIds: false,
    }),
    sanitizeToolCallIds: false,
  };
}

const dynamicModelCache = new Map<string, ProviderRuntimeModel[]>();
const OLLAMA_CLOUD_DEFAULT_MODEL_REF = `${OLLAMA_CLOUD_PROVIDER_ID}/${OLLAMA_CLOUD_DEFAULT_MODELS[0]}`;
const OLLAMA_CONFIGURED_SHOW_CONCURRENCY = 4;
const OLLAMA_CONFIGURED_SHOW_MAX_MODELS = 8;
const OLLAMA_API_KEY_ENV_REF_RE = /^[A-Z_][A-Z0-9_]*$/u;

function buildDynamicCacheKey(provider: string, baseUrl: string | undefined): string {
  return `${provider}\0${baseUrl ?? ""}`;
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
    api: "ollama",
    baseUrl: readProviderBaseUrl(params.providerConfig) ?? "",
    reasoning: params.model.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    cost: params.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.model.contextWindow ?? 8192,
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

function readEnvBackedOllamaApiKey(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const ref = coerceSecretRef(value);
  if (ref?.source === "env") {
    return readConcreteOllamaApiKey(env[ref.id.trim()]);
  }
  const apiKey = readConfiguredOllamaApiKey(value);
  return apiKey && OLLAMA_API_KEY_ENV_REF_RE.test(apiKey)
    ? readConcreteOllamaApiKey(env[apiKey])
    : undefined;
}

function isAmbientOllamaApiKeyMarker(value: string | undefined): boolean {
  return value === OLLAMA_DEFAULT_API_KEY || value === "OLLAMA_API_KEY";
}

function readUsableOllamaShowApiKey(params: {
  env: NodeJS.ProcessEnv;
  allowAmbientEnvFallback: boolean;
  explicitApiKey?: string;
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
  if (apiKey && !OLLAMA_API_KEY_ENV_REF_RE.test(apiKey)) {
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
    models: OLLAMA_CLOUD_DEFAULT_MODELS.map((model) => buildOllamaModelDefinition(model)),
  };
}

async function buildOllamaCloudProvider(): Promise<ModelProviderConfig> {
  const discovered = await buildOllamaProvider(OLLAMA_CLOUD_BASE_URL, { quiet: true });
  return discovered.models?.length ? discovered : buildStaticOllamaCloudProvider();
}

async function resolveRequestedDynamicOllamaModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  modelId: string;
  showApiKey?: string;
}): Promise<ProviderRuntimeModel | undefined> {
  const showBaseUrl = readProviderBaseUrl(params.providerConfig) ?? OLLAMA_DEFAULT_BASE_URL;
  const showInfo = params.showApiKey
    ? await queryOllamaModelShowInfo(showBaseUrl, params.modelId, { apiKey: params.showApiKey })
    : await queryOllamaModelShowInfo(showBaseUrl, params.modelId);
  if (typeof showInfo.contextWindow !== "number" && (showInfo.capabilities?.length ?? 0) === 0) {
    return undefined;
  }
  return toDynamicOllamaModel({
    provider: params.provider,
    providerConfig: params.providerConfig,
    model: buildOllamaModelDefinition(
      params.modelId,
      showInfo.contextWindow,
      showInfo.capabilities,
    ),
  });
}

async function augmentConfiguredOllamaCatalogModels(params: {
  config?: OpenClawConfig;
  defaultBaseUrl: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  entries: ProviderAugmentModelCatalogContext["entries"];
  resolveProviderApiKey: ProviderAugmentModelCatalogContext["resolveProviderApiKey"];
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
    explicitApiKey: readConfiguredOllamaApiKey(configuredProvider?.apiKey),
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

export default definePluginEntry({
  id: "ollama",
  name: "Ollama Provider",
  description: "Bundled Ollama provider plugin",
  register(api: OpenClawPluginApi) {
    if (api.registrationMode === "full") {
      void checkWsl2CrashLoopRisk(api.logger);
    }
    api.registerMemoryEmbeddingProvider(ollamaMemoryEmbeddingProviderAdapter);
    api.registerMediaUnderstandingProvider(ollamaMediaUnderstandingProvider);
    const startupPluginConfig = (api.pluginConfig ?? {}) as OllamaPluginConfig;
    const resolveCurrentPluginConfig = (config?: OpenClawConfig): OllamaPluginConfig => {
      const runtimePluginConfig = resolvePluginConfigObject(config, "ollama");
      if (runtimePluginConfig) {
        return runtimePluginConfig as OllamaPluginConfig;
      }
      return config ? {} : startupPluginConfig;
    };
    api.registerWebSearchProvider(createOllamaWebSearchProvider());
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
          const apiKey = ctx.resolveProviderApiKey(OLLAMA_CLOUD_PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...(await buildOllamaCloudProvider()),
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
      createStreamFn: ({ config, model, provider }) => {
        return createConfiguredOllamaStreamFn({
          model,
          providerBaseUrl:
            readProviderBaseUrl(
              resolveConfiguredOllamaProviderConfig({ config, providerId: provider }),
            ) ?? OLLAMA_CLOUD_BASE_URL,
        });
      },
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      buildReplayPolicy: (ctx) =>
        ctx.modelApi === "ollama"
          ? buildNativeOllamaReplayPolicy()
          : buildOpenAICompatibleReplayPolicy(ctx.modelApi),
      resolveReasoningOutputMode: () => "native",
      resolveThinkingProfile: resolveOllamaThinkingProfile,
      wrapStreamFn: createConfiguredOllamaCompatStreamWrapper,
      augmentModelCatalog: async (ctx) =>
        await augmentConfiguredOllamaCatalogModels({
          config: ctx.config,
          defaultBaseUrl: OLLAMA_CLOUD_BASE_URL,
          env: ctx.env,
          provider: OLLAMA_CLOUD_PROVIDER_ID,
          entries: ctx.entries,
          resolveProviderApiKey: ctx.resolveProviderApiKey,
        }),
      matchesContextOverflowError: ({ errorMessage }) =>
        /\bollama\b.*(?:context length|too many tokens|context window)/i.test(errorMessage) ||
        /\btruncating input\b.*\btoo long\b/i.test(errorMessage),
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
          hint: "Cloud and local open models",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const result = await promptAndConfigureOllama({
              cfg: ctx.config,
              env: ctx.env,
              opts: ctx.opts as Record<string, unknown> | undefined,
              prompter: ctx.prompter,
              secretInputMode: ctx.secretInputMode,
              allowSecretRefPrompt: ctx.allowSecretRefPrompt,
            });
            return {
              profiles: [
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
              ],
              configPatch: result.config,
            };
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
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
            buildProvider: buildOllamaProvider,
          }),
      },
      wizard: {
        setup: {
          choiceId: "ollama",
          choiceLabel: "Ollama",
          choiceHint: "Cloud and local open models",
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
        await ensureOllamaModelPulled({ config, model, prompter });
      },
      createStreamFn: ({ config, model, provider }) => {
        return createConfiguredOllamaStreamFn({
          model,
          providerBaseUrl: readProviderBaseUrl(
            resolveConfiguredOllamaProviderConfig({ config, providerId: provider }),
          ),
        });
      },
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      buildReplayPolicy: (ctx) =>
        ctx.modelApi === "ollama"
          ? buildNativeOllamaReplayPolicy()
          : buildOpenAICompatibleReplayPolicy(ctx.modelApi),
      resolveReasoningOutputMode: () => "native",
      resolveThinkingProfile: resolveOllamaThinkingProfile,
      wrapStreamFn: createConfiguredOllamaCompatStreamWrapper,
      augmentModelCatalog: async (ctx) =>
        await augmentConfiguredOllamaCatalogModels({
          config: ctx.config,
          defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
          env: ctx.env,
          provider: OLLAMA_PROVIDER_ID,
          entries: ctx.entries,
          resolveProviderApiKey: ctx.resolveProviderApiKey,
        }),
      createEmbeddingProvider: async ({ config, model, provider: embeddingProvider, remote }) => {
        const { provider, client } = await createOllamaEmbeddingProvider({
          config,
          remote,
          model: model || DEFAULT_OLLAMA_EMBEDDING_MODEL,
          provider: embeddingProvider || OLLAMA_PROVIDER_ID,
        });
        return {
          ...provider,
          client,
        };
      },
      matchesContextOverflowError: ({ errorMessage }) =>
        /\bollama\b.*(?:context length|too many tokens|context window)/i.test(errorMessage) ||
        /\btruncating input\b.*\btoo long\b/i.test(errorMessage),
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
          return;
        }
        const baseUrl = readProviderBaseUrl(providerConfig);
        const provider = await buildOllamaProvider(baseUrl, { quiet: true });
        const dynamicModels = (provider.models ?? []).map((model) =>
          toDynamicOllamaModel({
            provider: ctx.provider,
            providerConfig: provider,
            model,
          }),
        );
        if (!dynamicModels.some((model) => model.id === ctx.modelId)) {
          const requestedModel = await resolveRequestedDynamicOllamaModel({
            provider: ctx.provider,
            providerConfig: provider,
            modelId: ctx.modelId,
          });
          if (requestedModel) {
            dynamicModels.push(requestedModel);
          }
        }
        dynamicModelCache.set(buildDynamicCacheKey(ctx.provider, baseUrl), dynamicModels);
      },
      resolveDynamicModel: (ctx) => {
        const providerConfig = resolveConfiguredOllamaProviderConfig({
          config: ctx.config,
          providerId: ctx.provider,
        });
        return dynamicModelCache
          .get(buildDynamicCacheKey(ctx.provider, readProviderBaseUrl(providerConfig)))
          ?.find((model) => model.id === ctx.modelId);
      },
      buildUnknownModelHint: () =>
        "Ollama requires authentication to be registered as a provider. " +
        'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/ollama",
    });
  },
});
