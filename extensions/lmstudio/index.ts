import { adaptMemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
// Lmstudio plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethod,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { lmstudioMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
  LMSTUDIO_PROVIDER_LABEL,
} from "./src/defaults.js";
import {
  normalizeLmstudioConfiguredCatalogEntries,
  normalizeLmstudioProviderConfig,
  resolveLoadedContextWindow,
  resolveLmstudioInferenceBase,
} from "./src/models.js";
import { shouldUseLmstudioSyntheticAuth } from "./src/provider-auth.js";
import { wrapLmstudioInferencePreload } from "./src/stream.js";

const PROVIDER_ID = "lmstudio";
// Intentional: dynamic models are cached per LM Studio endpoint (`baseUrl`) only.
const cachedDynamicModels = new Map<string, ProviderRuntimeModel[]>();

type LmstudioNonInteractiveValidationContext = Parameters<
  NonNullable<ProviderAuthMethod["validateNonInteractive"]>
>[0];

async function validateLmstudioNonInteractive(
  ctx: LmstudioNonInteractiveValidationContext,
): Promise<boolean> {
  const configuredBaseUrl = normalizeOptionalSecretInput(ctx.opts.customBaseUrl);
  const dockerSetup = ["1", "true", "yes", "on"].includes(
    process.env.OPENCLAW_DOCKER_SETUP?.trim().toLowerCase() ?? "",
  );
  const baseUrl = resolveLmstudioInferenceBase(
    configuredBaseUrl ||
      (dockerSetup ? LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL : LMSTUDIO_DEFAULT_INFERENCE_BASE_URL),
  );
  const providerApiKey = normalizeOptionalSecretInput(ctx.opts.lmstudioApiKey);
  const resolvedApiKey = await ctx.resolveApiKey({
    provider: PROVIDER_ID,
    flagValue: providerApiKey ?? normalizeOptionalSecretInput(ctx.opts.customApiKey),
    flagName: providerApiKey === undefined ? "--custom-api-key" : "--lmstudio-api-key",
    envVar: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    envVarName: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    required: false,
  });

  // A reset preflight may inspect the model catalog but must never invoke
  // setup, write credentials, load a model, or mutate the model server.
  const { fetchLmstudioModels } = await import("./src/models.fetch.js");
  const discovery = await fetchLmstudioModels({
    baseUrl,
    apiKey: resolvedApiKey?.key ?? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    timeoutMs: 5000,
  });
  if (!discovery.reachable) {
    ctx.runtime.error(
      `LM Studio could not be reached at ${baseUrl}.\nStart LM Studio (or run lms server start) and re-run setup.`,
    );
    ctx.runtime.exit(1);
    return false;
  }
  if (discovery.status !== undefined && discovery.status >= 400) {
    ctx.runtime.error(
      `LM Studio returned HTTP ${discovery.status} while listing models at ${baseUrl}.\nCheck the base URL and API key, then re-run setup.`,
    );
    ctx.runtime.exit(1);
    return false;
  }

  const installedModels = discovery.models
    .filter((model) => model.type === "llm")
    .map((model) => model.key?.trim())
    .filter((model): model is string => Boolean(model));
  const loadedModels = discovery.models
    .filter(
      (model) =>
        model.type === "llm" &&
        Boolean(model.key?.trim()) &&
        resolveLoadedContextWindow(model) !== null,
    )
    .map((model) => model.key?.trim())
    .filter((model): model is string => Boolean(model));
  // Setup matches the requested wire key unchanged. Accepting provider-
  // qualified refs here would permit reset before setup rejects the model.
  const requestedModel = normalizeOptionalSecretInput(ctx.opts.customModelId);
  if (requestedModel && !installedModels.includes(requestedModel)) {
    ctx.runtime.error(
      `LM Studio model ${requestedModel} was not found at ${baseUrl}.\nAvailable models: ${installedModels.join(", ")}`,
    );
    ctx.runtime.exit(1);
    return false;
  }
  if (requestedModel && !loadedModels.includes(requestedModel)) {
    ctx.runtime.error(
      `LM Studio model ${requestedModel} is installed but not loaded at ${baseUrl}.\nLoad that model in LM Studio, then re-run setup.`,
    );
    ctx.runtime.exit(1);
    return false;
  }
  if (loadedModels.length === 0) {
    ctx.runtime.error(
      `No loaded LM Studio LLM models were found at ${baseUrl}.\nLoad a model in LM Studio (or run lms load <model>), then re-run setup.`,
    );
    ctx.runtime.exit(1);
    return false;
  }

  return true;
}

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
    api.registerEmbeddingProvider(
      adaptMemoryEmbeddingProviderAdapter(lmstudioMemoryEmbeddingProviderAdapter),
    );
    api.registerProvider({
      id: PROVIDER_ID,
      label: "LM Studio",
      docsPath: "/providers/lmstudio",
      envVars: [LMSTUDIO_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: LMSTUDIO_PROVIDER_LABEL,
          hint: "Connect to a running LM Studio server and use an already loaded model",
          kind: "custom",
          appGuidedSetup: {
            detect: async (ctx) => {
              const providerSetup = await loadProviderSetup();
              const result = await providerSetup.prepareAppGuidedLmstudioSetup(ctx);
              if (!result?.defaultModel) {
                return null;
              }
              const provider = result.configPatch?.models?.providers?.[PROVIDER_ID];
              return {
                modelRef: result.defaultModel,
                detail: `${result.defaultModel.slice(`${PROVIDER_ID}/`.length)} at ${provider?.baseUrl ?? "LM Studio"}`,
              };
            },
            prepare: async (ctx) => {
              const providerSetup = await loadProviderSetup();
              return await providerSetup.prepareAppGuidedLmstudioSetup(ctx);
            },
          },
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureLmstudioInteractive({
              config: ctx.config,
              agentDir: ctx.agentDir,
              prompter: ctx.prompter,
              secretInputMode: ctx.secretInputMode,
              allowSecretRefPrompt: ctx.allowSecretRefPrompt,
              isRemote: ctx.isRemote,
              signal: ctx.signal,
            });
          },
          validateNonInteractive: validateLmstudioNonInteractive,
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureLmstudioNonInteractive(ctx);
          },
        },
      ],
      catalog: {
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
      ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
      wizard: {
        setup: {
          choiceId: PROVIDER_ID,
          choiceLabel: "LM Studio",
          choiceHint: "Connect to a running LM Studio server and use an already loaded model",
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
