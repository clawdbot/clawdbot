/**
 * Arcee AI provider plugin entry. It supports direct Arcee auth and OpenRouter
 * routing while normalizing OpenRouter model ids and base URLs.
 */
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  readConfiguredProviderCatalogEntries,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyArceeConfig,
  applyArceeOpenRouterConfig,
  ARCEE_DEFAULT_MODEL_REF,
  ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
} from "./onboard.js";
import {
  buildArceeProvider,
  buildArceeOpenRouterProvider,
  normalizeArceeOpenRouterBaseUrl,
  toArceeOpenRouterModelId,
} from "./provider-catalog.js";

const PROVIDER_ID = "arcee";
const ARCEE_WIZARD_GROUP = {
  groupId: "arcee",
  groupLabel: "Arcee AI",
  groupHint: "Direct API or OpenRouter",
} as const;

async function resolveArceeCatalog(ctx: ProviderCatalogContext) {
  const directAuth = ctx.resolveProviderApiKey(PROVIDER_ID);
  if (directAuth.apiKey) {
    return {
      provider: await buildOpenAICompatibleLiveModelProviderConfig({
        providerId: PROVIDER_ID,
        providerConfig: buildArceeProvider(),
        apiKey: directAuth.apiKey,
        discoveryApiKey: directAuth.discoveryApiKey,
      }),
    };
  }

  const openRouterKey = ctx.resolveProviderApiKey("openrouter").apiKey;
  if (openRouterKey) {
    return { provider: { ...buildArceeOpenRouterProvider(), apiKey: openRouterKey } };
  }

  return null;
}

function normalizeArceeResolvedModel<T extends { baseUrl?: string; id: string }>(
  model: T,
): T | undefined {
  const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(model.baseUrl);
  if (!normalizedBaseUrl) {
    return undefined;
  }
  const normalizedId = toArceeOpenRouterModelId(model.id);
  if (normalizedId === model.id && normalizedBaseUrl === model.baseUrl) {
    return undefined;
  }
  return {
    ...model,
    id: normalizedId,
    baseUrl: normalizedBaseUrl,
  };
}

/** Provider entry for Arcee direct and OpenRouter-backed models. */
export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Arcee AI Provider",
  description: "Bundled Arcee AI provider plugin",
  provider: {
    label: "Arcee AI",
    docsPath: "/providers/arcee",
    envVars: ["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"],
    auth: [
      {
        methodId: "arcee-platform",
        label: "Arcee AI API key",
        hint: "Direct access to Arcee platform",
        optionKey: "arceeaiApiKey",
        flagName: "--arceeai-api-key",
        envVar: "ARCEEAI_API_KEY",
        promptMessage: "Enter Arcee AI API key",
        defaultModel: ARCEE_DEFAULT_MODEL_REF,
        applyConfig: applyArceeConfig,
        wizard: {
          choiceId: "arceeai-api-key",
          choiceLabel: "Arcee AI API key",
          choiceHint: "Direct (chat.arcee.ai)",
          ...ARCEE_WIZARD_GROUP,
        },
      },
      {
        methodId: "openrouter",
        label: "OpenRouter API key",
        hint: "Access Arcee models via OpenRouter",
        optionKey: "openrouterApiKey",
        flagName: "--openrouter-api-key",
        envVar: "OPENROUTER_API_KEY",
        promptMessage: "Enter OpenRouter API key",
        profileId: "openrouter:default",
        defaultModel: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
        expectedProviders: [PROVIDER_ID, "openrouter"],
        applyConfig: applyArceeOpenRouterConfig,
        wizard: {
          choiceId: "arceeai-openrouter",
          choiceLabel: "OpenRouter API key",
          choiceHint: "Via OpenRouter (openrouter.ai)",
          ...ARCEE_WIZARD_GROUP,
        },
      },
    ],
    catalog: {
      run: resolveArceeCatalog,
      staticRun: async () => ({ provider: buildArceeProvider() }),
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    normalizeConfig: ({ providerConfig }) => {
      const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(providerConfig.baseUrl);
      return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
        ? { ...providerConfig, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeResolvedModel: ({ model }) => normalizeArceeResolvedModel(model),
    normalizeTransport: ({ api: apiLocal, baseUrl }) => {
      const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(baseUrl);
      return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
        ? {
            api: apiLocal,
            baseUrl: normalizedBaseUrl,
          }
        : undefined;
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
  },
});
