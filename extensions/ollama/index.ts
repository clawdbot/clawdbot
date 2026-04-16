import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildApiKeyCredential } from "openclaw/plugin-sdk/provider-auth";
import {
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import {
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./api.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./src/embedding-provider.js";
import { ollamaMemoryEmbeddingProviderAdapter } from "./src/memory-embedding-adapter.js";
import { resolveOllamaApiBase } from "./src/provider-models.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
  resolveConfiguredOllamaProviderConfig,
} from "./src/stream.js";
import { createOllamaWebSearchProvider } from "./src/web-search-provider.js";

const PROVIDER_ID = "ollama";
const DEFAULT_API_KEY = "ollama-local";

type OllamaPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

type OllamaProviderLikeConfig = ModelProviderConfig;

function resolveOllamaDiscoveryApiKey(params: {
  env: NodeJS.ProcessEnv;
  explicitApiKey?: string;
  resolvedApiKey?: string;
}): string {
  const envApiKey = params.env.OLLAMA_API_KEY?.trim() ? "OLLAMA_API_KEY" : undefined;
  const explicitApiKey = normalizeOptionalString(params.explicitApiKey);
  const resolvedApiKey = normalizeOptionalString(params.resolvedApiKey);
  return envApiKey ?? explicitApiKey ?? resolvedApiKey ?? DEFAULT_API_KEY;
}

function shouldSkipAmbientOllamaDiscovery(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

function hasMeaningfulExplicitOllamaConfig(providerConfig?: OllamaProviderLikeConfig): boolean {
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

export default definePluginEntry({
  id: "ollama",
  name: "Ollama Provider",
  description: "Bundled Ollama provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerMemoryEmbeddingProvider(ollamaMemoryEmbeddingProviderAdapter);
    const pluginConfig = (api.pluginConfig ?? {}) as OllamaPluginConfig;
    api.registerWebSearchProvider(createOllamaWebSearchProvider());
    api.registerProvider({
      id: PROVIDER_ID,
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
                    PROVIDER_ID,
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
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
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
          if (provider.models.length === 0 && !ollamaKey && !explicit?.apiKey) {
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
        },
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
          providerBaseUrl: resolveConfiguredOllamaProviderConfig({ config, providerId: provider })
            ?.baseUrl,
        });
      },
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      resolveReasoningOutputMode: () => "native",
      wrapStreamFn: createConfiguredOllamaCompatStreamWrapper,
      createEmbeddingProvider: async ({ config, model, remote }) => {
        const { provider, client } = await createOllamaEmbeddingProvider({
          config,
          remote,
          model: model || DEFAULT_OLLAMA_EMBEDDING_MODEL,
        });
        return {
          ...provider,
          client,
        };
      },
      matchesContextOverflowError: ({ errorMessage }) =>
        /\bollama\b.*(?:context length|too many tokens|context window)/i.test(errorMessage) ||
        /\btruncating input\b.*\btoo long\b/i.test(errorMessage),
      resolveSyntheticAuth: ({ providerConfig }) => {
        if (!hasMeaningfulExplicitOllamaConfig(providerConfig)) {
          return undefined;
        }
        return {
          apiKey: DEFAULT_API_KEY,
          source: "models.providers.ollama (synthetic local key)",
          mode: "api-key",
        };
      },
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === DEFAULT_API_KEY,
      buildUnknownModelHint: () =>
        "Ollama requires authentication to be registered as a provider. " +
        'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/ollama",
    });
  },
});
