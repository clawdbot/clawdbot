// Opencode Go plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyOpencodeGoConfig, OPENCODE_GO_DEFAULT_MODEL_REF } from "./api.js";
import { opencodeGoMediaUnderstandingProvider } from "./media-understanding-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  listOpencodeGoModelCatalogEntries,
  normalizeOpencodeGoBaseUrl,
  normalizeOpencodeGoResolvedModel,
  resolveOpencodeGoModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { createOpencodeGoWrapper } from "./stream.js";

const PROVIDER_ID = "opencode-go";
const OPENCODE_SHARED_PROFILE_IDS = ["opencode:default", "opencode-go:default"] as const;
const OPENCODE_SHARED_HINT = "Shared API key for Zen + Go catalogs";
type OpencodeGoCatalogAuth = {
  apiKey?: string;
  discoveryApiKey?: string;
};

function hasCatalogAuth(auth: OpencodeGoCatalogAuth): boolean {
  return Boolean(auth.apiKey || auth.discoveryApiKey);
}

function resolveOpencodeGoCatalogAuth(
  resolveProviderApiKey: (providerId: string) => OpencodeGoCatalogAuth,
): OpencodeGoCatalogAuth | undefined {
  const opencodeGoAuth = resolveProviderApiKey(PROVIDER_ID);
  if (hasCatalogAuth(opencodeGoAuth)) {
    return opencodeGoAuth;
  }
  const sharedOpencodeAuth = resolveProviderApiKey("opencode");
  return hasCatalogAuth(sharedOpencodeAuth) ? sharedOpencodeAuth : undefined;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Go Provider",
  description: "Bundled OpenCode Go provider plugin",
  manifest,
  provider: {
    label: "OpenCode Go",
    docsPath: "/providers/models",
    envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    manifestAuth: {
      hint: OPENCODE_SHARED_HINT,
      promptMessage: "Enter OpenCode API key",
      profileIds: [...OPENCODE_SHARED_PROFILE_IDS],
      defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
      applyConfig: applyOpencodeGoConfig,
      expectedProviders: ["opencode", "opencode-go"],
      noteMessage: [
        "OpenCode uses one API key across the Zen and Go catalogs.",
        "Go focuses on Kimi, GLM, and MiniMax coding models.",
        "Get your API key at: https://opencode.ai/auth",
      ].join("\n"),
      noteTitle: "OpenCode",
    },
    normalizeConfig: ({ providerConfig }) => {
      const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({
        api: providerConfig.api,
        baseUrl: providerConfig.baseUrl,
      });
      return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
        ? { ...providerConfig, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeResolvedModel: ({ model }) => {
      const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({
        api: model.api,
        baseUrl: model.baseUrl,
      });
      const baseUrlNormalized =
        normalizedBaseUrl && normalizedBaseUrl !== model.baseUrl
          ? { ...model, baseUrl: normalizedBaseUrl }
          : model;
      const modelNormalized = normalizeOpencodeGoResolvedModel(baseUrlNormalized);
      if (modelNormalized) {
        return modelNormalized;
      }
      return baseUrlNormalized !== model ? baseUrlNormalized : undefined;
    },
    normalizeTransport: ({ api: apiLocal, baseUrl }) => {
      const normalizedBaseUrl = normalizeOpencodeGoBaseUrl({ api: apiLocal, baseUrl });
      return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
        ? {
            api: apiLocal,
            baseUrl: normalizedBaseUrl,
          }
        : undefined;
    },
    resolveDynamicModel: ({ modelId }) => resolveOpencodeGoModel(modelId),
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const auth = resolveOpencodeGoCatalogAuth(ctx.resolveProviderApiKey);
        if (!auth) {
          return null;
        }
        if (!auth.discoveryApiKey) {
          return {
            provider: buildStaticOpencodeGoProviderConfig(auth.apiKey),
          };
        }
        return {
          provider: await buildOpencodeGoLiveProviderConfig({
            apiKey: auth.apiKey ?? auth.discoveryApiKey,
            discoveryApiKey: auth.discoveryApiKey,
          }),
        };
      },
    },
    augmentModelCatalog: () => listOpencodeGoModelCatalogEntries(),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    resolveThinkingProfile,
    wrapStreamFn: (ctx) => createOpencodeGoWrapper(ctx.streamFn, ctx.thinkingLevel),
    isModernModelRef: () => true,
  },
  register(api) {
    api.registerMediaUnderstandingProvider(opencodeGoMediaUnderstandingProvider);
  },
});
