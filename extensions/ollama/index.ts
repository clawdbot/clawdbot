import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildApiKeyCredential } from "openclaw/plugin-sdk/provider-auth";
import { OPENAI_COMPATIBLE_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./api.js";
import {
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_PROVIDER_ID,
  hasMeaningfulExplicitOllamaConfig,
  resolveOllamaDiscoveryResult,
  type OllamaPluginConfig,
} from "./src/discovery-shared.js";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./src/embedding-provider.js";
import { ollamaMediaUnderstandingProvider } from "./src/media-understanding-provider.js";
import { ollamaMemoryEmbeddingProviderAdapter } from "./src/memory-embedding-adapter.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
  isOllamaCompatProvider,
  resolveConfiguredOllamaProviderConfig,
} from "./src/stream.js";
import { createOllamaWebSearchProvider } from "./src/web-search-provider.js";

function usesOllamaOpenAICompatTransport(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  return (
    model.api === "openai-completions" &&
    isOllamaCompatProvider({
      provider: typeof model.provider === "string" ? model.provider : undefined,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      api: "openai-completions",
    })
  );
}

export default definePluginEntry({
  id: "ollama",
  name: "Ollama Provider",
  description: "Bundled Ollama provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerMemoryEmbeddingProvider(ollamaMemoryEmbeddingProviderAdapter);
    api.registerMediaUnderstandingProvider(ollamaMediaUnderstandingProvider);
    const pluginConfig = (api.pluginConfig ?? {}) as OllamaPluginConfig;
    api.registerWebSearchProvider(createOllamaWebSearchProvider());
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
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) =>
          await resolveOllamaDiscoveryResult({
            ctx,
            pluginConfig,
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
          providerBaseUrl: resolveConfiguredOllamaProviderConfig({ config, providerId: provider })
            ?.baseUrl,
        });
      },
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      contributeResolvedModelCompat: ({ model }) =>
        usesOllamaOpenAICompatTransport(model) ? { supportsUsageInStreaming: true } : undefined,
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
          apiKey: OLLAMA_DEFAULT_API_KEY,
          source: "models.providers.ollama (synthetic local key)",
          mode: "api-key",
        };
      },
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === OLLAMA_DEFAULT_API_KEY,
      buildUnknownModelHint: () =>
        "Ollama requires authentication to be registered as a provider. " +
        'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/ollama",
    });
  },
});
