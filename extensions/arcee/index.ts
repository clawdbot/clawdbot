import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  readConfiguredProviderCatalogEntries,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { OPENAI_COMPATIBLE_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  applyArceeConfig,
  applyArceeOpenRouterConfig,
  ARCEE_DEFAULT_MODEL_REF,
  ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
} from "./onboard.js";
import {
  buildArceeProvider,
  buildArceeOpenRouterProvider,
  isArceeOpenRouterBaseUrl,
  toArceeOpenRouterModelId,
} from "./provider-catalog.js";

const PROVIDER_ID = "arcee";
const ARCEE_WIZARD_GROUP = {
  groupId: "arcee",
  groupLabel: "Arcee AI",
  groupHint: "Direct API or OpenRouter",
} as const;

function buildArceeAuthMethods() {
  return [
    createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "arcee-platform",
      label: "Arcee AI API key",
      hint: "Direct access to Arcee platform",
      optionKey: "arceeaiApiKey",
      flagName: "--arceeai-api-key",
      envVar: "ARCEEAI_API_KEY",
      promptMessage: "Enter Arcee AI API key",
      defaultModel: ARCEE_DEFAULT_MODEL_REF,
      expectedProviders: [PROVIDER_ID],
      applyConfig: (cfg) => applyArceeConfig(cfg),
      wizard: {
        choiceId: "arceeai-api-key",
        choiceLabel: "Arcee AI API key",
        choiceHint: "Direct (chat.arcee.ai)",
        ...ARCEE_WIZARD_GROUP,
      },
    }),
    createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
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
      applyConfig: (cfg) => applyArceeOpenRouterConfig(cfg),
      wizard: {
        choiceId: "arceeai-openrouter",
        choiceLabel: "OpenRouter API key",
        choiceHint: "Via OpenRouter (openrouter.ai)",
        ...ARCEE_WIZARD_GROUP,
      },
    }),
  ];
}

function readConfiguredArceeCatalogEntries(config: OpenClawConfig | undefined) {
  return readConfiguredProviderCatalogEntries({
    config,
    providerId: PROVIDER_ID,
  });
}

async function resolveArceeCatalog(ctx: ProviderCatalogContext) {
  const directKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
  if (directKey) {
    return { provider: { ...buildArceeProvider(), apiKey: directKey } };
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
  if (!isArceeOpenRouterBaseUrl(model.baseUrl)) {
    return undefined;
  }
  return {
    ...model,
    id: toArceeOpenRouterModelId(model.id),
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Arcee AI Provider",
  description: "Bundled Arcee AI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Arcee AI",
      docsPath: "/providers/arcee",
      envVars: ["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"],
      auth: buildArceeAuthMethods(),
      catalog: {
        run: resolveArceeCatalog,
      },
      augmentModelCatalog: ({ config }) => readConfiguredArceeCatalogEntries(config),
      normalizeResolvedModel: ({ model }) => normalizeArceeResolvedModel(model),
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    });
  },
});
