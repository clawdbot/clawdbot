import type {
  OpenClawPluginApi,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { hasLlamaServerAuthorizationHeader, shouldUseLlamaServerSyntheticAuth } from "./auth.js";
import {
  LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
  LLAMA_SERVER_LOCAL_AUTH_MARKER,
  LLAMA_SERVER_PROVIDER_ID,
  LLAMA_SERVER_PROVIDER_LABEL,
} from "./defaults.js";
import { normalizeLlamaServerProviderConfig } from "./endpoint.js";
import {
  discoverLlamaServerProvider,
  listLlamaServerCatalog,
  prepareLlamaServerDynamicModels,
  resolveLlamaServerDynamicModel,
} from "./provider.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./setup.js";
import { wrapLlamaServerStream } from "./stream.js";

export function registerExternalLlamaServerProvider(api: OpenClawPluginApi): void {
  api.registerModelCatalogProvider({
    provider: LLAMA_SERVER_PROVIDER_ID,
    kinds: ["text"],
    liveCatalog: listLlamaServerCatalog,
  });
  api.registerProvider({
    id: LLAMA_SERVER_PROVIDER_ID,
    label: LLAMA_SERVER_PROVIDER_LABEL,
    docsPath: "/providers/llama-server",
    envVars: [LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR],
    auth: [
      {
        id: "custom",
        label: LLAMA_SERVER_PROVIDER_LABEL,
        hint: "Existing local or private llama.cpp server",
        kind: "custom",
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
      run: discoverLlamaServerProvider,
    },
    resolveSyntheticAuth: ({ providerConfig }) =>
      shouldUseLlamaServerSyntheticAuth(providerConfig)
        ? {
            apiKey: hasLlamaServerAuthorizationHeader(providerConfig?.headers)
              ? LLAMA_SERVER_LOCAL_AUTH_MARKER
              : CUSTOM_LOCAL_AUTH_MARKER,
            source: "models.providers.llama-server (synthetic local key)",
            mode: "api-key" as const,
          }
        : undefined,
    shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
      resolvedApiKey?.trim() === LLAMA_SERVER_LOCAL_AUTH_MARKER ||
      resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
    normalizeConfig: ({ providerConfig }) => normalizeLlamaServerProviderConfig(providerConfig),
    prepareDynamicModel: prepareLlamaServerDynamicModels,
    resolveDynamicModel: resolveLlamaServerDynamicModel,
    wrapStreamFn: wrapLlamaServerStream,
    ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
    wizard: {
      setup: {
        choiceId: LLAMA_SERVER_PROVIDER_ID,
        choiceLabel: "Existing llama-server",
        choiceHint: "Connect to an existing llama.cpp server",
        groupId: "llama-cpp",
        groupLabel: "Local llama.cpp",
        groupHint: "Managed or external llama.cpp server",
        methodId: "custom",
      },
      modelPicker: {
        label: "llama-server (external)",
        hint: "Discover models from an existing llama-server",
        methodId: "custom",
      },
    },
  });
}
