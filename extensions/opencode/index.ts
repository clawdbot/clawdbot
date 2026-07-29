// Opencode plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyOpencodeZenConfig, OPENCODE_ZEN_DEFAULT_MODEL } from "./api.js";
import { opencodeMediaUnderstandingProvider } from "./media-understanding-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeZenLiveProviderConfig,
  buildStaticOpencodeZenProviderConfig,
  listOpencodeZenModelCatalogEntries,
  normalizeOpencodeZenBaseUrl,
  resolveOpencodeZenModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile as resolveOpencodeThinkingProfile } from "./provider-policy-api.js";
import { registerOpenCodeSessionCatalog } from "./session-catalog-plugin.js";

const PROVIDER_ID = "opencode";
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;
const OPENCODE_SHARED_PROFILE_IDS = ["opencode:default", "opencode-go:default"] as const;
const OPENCODE_SHARED_HINT = "Shared API key for Zen + Go catalogs";
type OpencodeZenCatalogAuth = {
  apiKey?: string;
  discoveryApiKey?: string;
};

function hasCatalogAuth(auth: OpencodeZenCatalogAuth): boolean {
  return Boolean(auth.apiKey || auth.discoveryApiKey);
}

function resolveOpencodeZenCatalogAuth(
  resolveProviderApiKey: (providerId: string) => OpencodeZenCatalogAuth,
): OpencodeZenCatalogAuth | undefined {
  const opencodeAuth = resolveProviderApiKey(PROVIDER_ID);
  if (hasCatalogAuth(opencodeAuth)) {
    return opencodeAuth;
  }
  const sharedOpencodeGoAuth = resolveProviderApiKey("opencode-go");
  return hasCatalogAuth(sharedOpencodeGoAuth) ? sharedOpencodeGoAuth : undefined;
}

function isModernOpencodeModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  if (lower.endsWith("-free") || lower === "alpha-glm-4.7") {
    return false;
  }
  return !matchesExactOrPrefix(lower, MINIMAX_MODERN_MODEL_MATCHERS);
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Zen Provider",
  description: "Bundled OpenCode Zen provider plugin",
  manifest,
  provider: {
    label: "OpenCode Zen",
    docsPath: "/providers/models",
    envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    manifestAuth: {
      hint: OPENCODE_SHARED_HINT,
      promptMessage: "Enter OpenCode API key",
      profileIds: [...OPENCODE_SHARED_PROFILE_IDS],
      defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
      applyConfig: applyOpencodeZenConfig,
      expectedProviders: ["opencode", "opencode-go"],
      noteMessage: [
        "OpenCode uses one API key across the Zen and Go catalogs.",
        "Zen provides access to Claude, GPT, Gemini, and more models.",
        "Get your API key at: https://opencode.ai/auth",
        "Choose the Zen catalog when you want the curated multi-model proxy.",
      ].join("\n"),
      noteTitle: "OpenCode",
    },
    normalizeConfig: ({ providerConfig }) => {
      const normalizedBaseUrl = normalizeOpencodeZenBaseUrl({
        api: providerConfig.api,
        baseUrl: providerConfig.baseUrl,
      });
      return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
        ? { ...providerConfig, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeResolvedModel: ({ model }) => {
      const normalizedBaseUrl = normalizeOpencodeZenBaseUrl({
        api: model.api,
        baseUrl: model.baseUrl,
      });
      return normalizedBaseUrl && normalizedBaseUrl !== model.baseUrl
        ? { ...model, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeTransport: ({ api: apiLocal, baseUrl }) => {
      const normalizedBaseUrl = normalizeOpencodeZenBaseUrl({ api: apiLocal, baseUrl });
      return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
        ? {
            api: apiLocal,
            baseUrl: normalizedBaseUrl,
          }
        : undefined;
    },
    resolveDynamicModel: ({ modelId }) => resolveOpencodeZenModel(modelId),
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const auth = resolveOpencodeZenCatalogAuth(ctx.resolveProviderApiKey);
        if (!auth) {
          return null;
        }
        if (!auth.discoveryApiKey) {
          return {
            provider: buildStaticOpencodeZenProviderConfig(auth.apiKey),
          };
        }
        return {
          provider: await buildOpencodeZenLiveProviderConfig({
            apiKey: auth.apiKey ?? auth.discoveryApiKey,
            discoveryApiKey: auth.discoveryApiKey,
          }),
        };
      },
      staticRun: async () => ({ provider: buildStaticOpencodeZenProviderConfig() }),
    },
    augmentModelCatalog: () => listOpencodeZenModelCatalogEntries(),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
    resolveThinkingProfile: resolveOpencodeThinkingProfile,
  },
  register(api) {
    api.registerMediaUnderstandingProvider(opencodeMediaUnderstandingProvider);
    registerOpenCodeSessionCatalog(api);
  },
});
