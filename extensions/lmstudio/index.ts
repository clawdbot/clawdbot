import {
  definePluginEntry,
  OpenClawConfig,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { lmstudioMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
  LMSTUDIO_PROVIDER_LABEL,
} from "./src/defaults.js";
import {
  normalizeLmstudioConfiguredCatalogEntries,
  normalizeLmstudioProviderConfig,
} from "./src/models.js";
import { shouldUseLmstudioSyntheticAuth } from "./src/provider-auth.js";
import { wrapLmstudioInferencePreload } from "./src/stream.js";

const PROVIDER_ID = "lmstudio";
// Intentional: dynamic models are cached per LM Studio endpoint (`baseUrl`) only.
const cachedDynamicModels = new Map<string, ProviderRuntimeModel[]>();

function resolveLmstudioAugmentedCatalogEntries(config: OpenClawConfig | undefined) {
  if (!config) {
    return [];
  }
  return normalizeLmstudioConfiguredCatalogEntries(config.models?.providers?.lmstudio?.models).map(
    (entry) => ({
      provider: PROVIDER_ID,
      id: entry.id,
      name: entry.name ?? entry.id,
      compat: { ...entry.compat, supportsUsageInStreaming: true },
      contextWindow: entry.contextWindow,
      contextTokens: entry.contextTokens,
      reasoning: entry.reasoning,
      input: entry.input,
    }),
  );
}

/** Lazily loads setup helpers so provider wiring stays lightweight at startup. */
async function loadProviderSetup() {
  return await import("./api.js");
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "LM Studio Provider",
  description: "Bundled LM Studio provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerMemoryEmbeddingProvider(lmstudioMemoryEmbeddingProviderAdapter);
    api.registerProvider({
      id: PROVIDER_ID,
      label: "LM Studio",
      docsPath: "/providers/lmstudio",
      envVars: [LMSTUDIO_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: LMSTUDIO_PROVIDER_LABEL,
          hint: "Local/self-hosted LM Studio server",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureLmstudioInteractive({
              config: ctx.config,
              agentDir: ctx.agentDir,
              prompter: ctx.prompter,
              secretInputMode: ctx.secretInputMode,
              allowSecretRefPrompt: ctx.allowSecretRefPrompt,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureLmstudioNonInteractive(ctx);
          },
        },
      ],
      discovery: {
        // Run after early providers so local LM Studio detection does not dominate resolution.
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverLmstudioProvider(ctx);
        },
      },
      resolveSyntheticAuth: ({ providerConfig }) => {
        if (!shouldUseLmstudioSyntheticAuth(providerConfig)) {
          return undefined;
        }
        return {
          apiKey: CUSTOM_LOCAL_AUTH_MARKER,
          source: "models.providers.lmstudio (synthetic local key)",
          mode: "api-key" as const,
        };
      },
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER ||
        resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
      normalizeConfig: ({ providerConfig }) => normalizeLmstudioProviderConfig(providerConfig),
      prepareDynamicModel: async (ctx) => {
        const providerSetup = await loadProviderSetup();
        cachedDynamicModels.set(
          ctx.providerConfig?.baseUrl ?? "",
          await providerSetup.prepareLmstudioDynamicModels(ctx),
        );
      },
      resolveDynamicModel: (ctx) =>
        cachedDynamicModels
          .get(ctx.providerConfig?.baseUrl ?? "")
          ?.find((model) => model.id === ctx.modelId),
      augmentModelCatalog: (ctx) => resolveLmstudioAugmentedCatalogEntries(ctx.config),
      wrapStreamFn: wrapLmstudioInferencePreload,
      wizard: {
        setup: {
          choiceId: PROVIDER_ID,
          choiceLabel: "LM Studio",
          choiceHint: "Local/self-hosted LM Studio server",
          groupId: PROVIDER_ID,
          groupLabel: "LM Studio",
          groupHint: "Self-hosted open-weight models",
          methodId: "custom",
        },
        modelPicker: {
          label: "LM Studio (custom)",
          hint: "Detect models from LM Studio /api/v1/models",
          methodId: "custom",
        },
      },
    });
  },
});
