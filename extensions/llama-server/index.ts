import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import {
  hasLlamaServerAuthorizationHeader,
  shouldUseLlamaServerSyntheticAuth,
} from "./src/auth.js";
import {
  LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
  LLAMA_SERVER_LOCAL_AUTH_MARKER,
  LLAMA_SERVER_PROVIDER_ID,
  LLAMA_SERVER_PROVIDER_LABEL,
} from "./src/defaults.js";
import { normalizeLlamaServerProviderConfig } from "./src/endpoint.js";
import {
  discoverLlamaServerProvider,
  listLlamaServerCatalog,
  prepareLlamaServerDynamicModels,
  resolveLlamaServerDynamicModel,
} from "./src/provider.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./src/setup.js";
import { wrapLlamaServerStream } from "./src/stream.js";

export default definePluginEntry({
  id: LLAMA_SERVER_PROVIDER_ID,
  name: "llama-server Provider",
  description: "Connect OpenClaw to an existing llama.cpp server over HTTP",
  register(api: OpenClawPluginApi) {
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
      resolveDynamicModel: (ctx) => resolveLlamaServerDynamicModel(ctx),
      wrapStreamFn: wrapLlamaServerStream,
      ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
      wizard: {
        setup: {
          choiceId: LLAMA_SERVER_PROVIDER_ID,
          choiceLabel: LLAMA_SERVER_PROVIDER_LABEL,
          choiceHint: "Existing local or private llama.cpp server",
          groupId: LLAMA_SERVER_PROVIDER_ID,
          groupLabel: LLAMA_SERVER_PROVIDER_LABEL,
          groupHint: "Self-hosted llama.cpp models",
          methodId: "custom",
        },
        modelPicker: {
          label: `${LLAMA_SERVER_PROVIDER_LABEL} (self-hosted)`,
          hint: "Discover models from an existing llama-server",
          methodId: "custom",
        },
      },
    });
  },
});
