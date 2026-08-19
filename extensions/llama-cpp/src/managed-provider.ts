import type {
  OpenClawPluginApi,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_PROVIDER_LABEL,
  buildLlamaCppProviderConfig,
  resolveLlamaCppSyntheticApiKey,
} from "./defaults.js";
import {
  hasLlamaServerAuthorizationHeader,
  shouldUseLlamaServerSyntheticAuth,
} from "./external-server/auth.js";
import {
  LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
  LLAMA_SERVER_DEFAULT_ORIGIN,
} from "./external-server/defaults.js";
import { normalizeLlamaServerProviderConfig } from "./external-server/endpoint.js";
import {
  discoverLlamaServerProvider,
  listLlamaServerCatalog,
  prepareLlamaServerDynamicModels,
  resolveLlamaServerDynamicModel,
} from "./external-server/provider.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./external-server/setup.js";
import { wrapLlamaServerStream } from "./external-server/stream.js";
import { ensureManagedLlamaServerForChat } from "./managed-server.js";
import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./setup.js";

export function registerLlamaCppProvider(api: OpenClawPluginApi): void {
  api.registerModelCatalogProvider({
    provider: LLAMA_CPP_PROVIDER_ID,
    kinds: ["text"],
    liveCatalog: async (ctx) =>
      ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.localService
        ? []
        : await listLlamaServerCatalog(ctx),
  });
  api.registerProvider({
    id: LLAMA_CPP_PROVIDER_ID,
    label: LLAMA_CPP_PROVIDER_LABEL,
    docsPath: "/plugins/llama-cpp",
    envVars: [LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR],
    auth: [
      {
        id: "local",
        label: LLAMA_CPP_PROVIDER_LABEL,
        hint: "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
        kind: "custom",
        wizard: {
          choiceId: LLAMA_CPP_PROVIDER_ID,
          choiceLabel: "Managed local server",
          choiceHint:
            "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "Local llama.cpp",
          groupHint: "Managed or external llama.cpp server",
          methodId: "local",
        },
        appGuidedSetup: {
          detect: detectLlamaCppSetup,
          prepare: prepareLlamaCppSetup,
        },
        run: runLlamaCppSetup,
      },
      {
        id: "existing-server",
        label: "Existing llama-server",
        hint: "Connect to an existing local, private, or remote llama.cpp server",
        kind: "custom",
        wizard: {
          choiceId: "llama-cpp-existing-server",
          choiceLabel: "Existing llama-server",
          choiceHint: "Connect to a llama.cpp server managed outside OpenClaw",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "Local llama.cpp",
          groupHint: "Managed or external llama.cpp server",
          methodId: "existing-server",
        },
        appGuidedSetup: {
          detect: detectLlamaServerSetup,
          prepare: prepareLlamaServerSetup,
        },
        run: runLlamaServerSetup,
        validateNonInteractive: validateLlamaServerNonInteractive,
        runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
          await configureLlamaServerNonInteractive(ctx),
      },
    ],
    catalog: {
      order: "late",
      run: async (ctx) => {
        const configured = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
        return configured?.localService
          ? { provider: buildLlamaCppProviderConfig(configured) }
          : await discoverLlamaServerProvider(ctx);
      },
    },
    staticCatalog: {
      order: "late",
      run: async () => ({ provider: buildLlamaCppProviderConfig() }),
    },
    resolveSyntheticAuth: ({ providerConfig }) =>
      providerConfig?.localService || shouldUseLlamaServerSyntheticAuth(providerConfig)
        ? {
            apiKey: resolveLlamaCppSyntheticApiKey(),
            source: providerConfig?.localService
              ? "managed local llama.cpp server"
              : hasLlamaServerAuthorizationHeader(providerConfig?.headers)
                ? "models.providers.llama-cpp.headers.Authorization"
                : "models.providers.llama-cpp (synthetic local key)",
            mode: "api-key" as const,
          }
        : undefined,
    shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
      resolvedApiKey?.trim() === resolveLlamaCppSyntheticApiKey() ||
      resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
    normalizeConfig: ({ providerConfig }) =>
      providerConfig.localService
        ? providerConfig
        : normalizeLlamaServerProviderConfig(providerConfig),
    prepareDynamicModel: async (ctx) => {
      if (!ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.localService) {
        await prepareLlamaServerDynamicModels(ctx);
      }
    },
    resolveDynamicModel: (ctx) =>
      ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.localService
        ? undefined
        : resolveLlamaServerDynamicModel(ctx),
    wrapStreamFn: (ctx) => {
      const providerConfig = ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
      if (!providerConfig?.localService) {
        return wrapLlamaServerStream(ctx);
      }
      const inner = ctx.streamFn;
      const selectedModel = ctx.model;
      if (!inner || !selectedModel) {
        return undefined;
      }
      return async (model, context, options) => {
        await ensureManagedLlamaServerForChat({
          provider: providerConfig,
          model: selectedModel,
        });
        return inner(model, context, options);
      };
    },
    ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
    wizard: {
      modelPicker: {
        label: "llama.cpp",
        hint: `Use a managed server or connect to ${LLAMA_SERVER_DEFAULT_ORIGIN}`,
        methodId: "local",
      },
    },
  });
}
