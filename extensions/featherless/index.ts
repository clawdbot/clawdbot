// Featherless plugin entrypoint registers its OpenClaw integration.
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  cloneFirstTemplateModel,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { applyFeatherlessConfig, FEATHERLESS_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildFeatherlessProvider,
  FEATHERLESS_BASE_URL,
  FEATHERLESS_DEFAULT_MODEL_ID,
  FEATHERLESS_DYNAMIC_COMPAT,
  FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
  FEATHERLESS_DYNAMIC_MAX_TOKENS,
  isFeatherlessCatalogModelId,
} from "./provider-catalog.js";

const PROVIDER_ID = "featherless";

function resolveFeatherlessDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const modelId = ctx.modelId.trim();
  if (!modelId || isFeatherlessCatalogModelId(modelId)) {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId,
      templateIds: [FEATHERLESS_DEFAULT_MODEL_ID],
      ctx,
      patch: {
        provider: PROVIDER_ID,
        reasoning: false,
        input: ["text"],
        contextWindow: FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
        maxTokens: FEATHERLESS_DYNAMIC_MAX_TOKENS,
        compat: FEATHERLESS_DYNAMIC_COMPAT,
      },
    }) ??
    normalizeModelCompat({
      id: modelId,
      name: modelId,
      provider: PROVIDER_ID,
      api: "openai-completions",
      baseUrl: FEATHERLESS_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
      maxTokens: FEATHERLESS_DYNAMIC_MAX_TOKENS,
      compat: FEATHERLESS_DYNAMIC_COMPAT,
    })
  );
}

function normalizeFeatherlessResolvedModel(model: ProviderRuntimeModel): ProviderRuntimeModel {
  return {
    ...model,
    compat: {
      ...FEATHERLESS_DYNAMIC_COMPAT,
      ...model.compat,
    },
  };
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Featherless AI Provider",
  description: "Featherless AI provider plugin",
  provider: {
    label: "Featherless AI",
    docsPath: "/providers/featherless",
    envVars: ["FEATHERLESS_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "Featherless AI API key",
        hint: "OpenAI-compatible access to open models",
        optionKey: "featherlessApiKey",
        flagName: "--featherless-api-key",
        envVar: "FEATHERLESS_API_KEY",
        promptMessage: "Enter Featherless AI API key",
        defaultModel: FEATHERLESS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyFeatherlessConfig(cfg),
        noteTitle: "Featherless AI",
        noteMessage: [
          "Featherless AI serves open models through an OpenAI-compatible API.",
          "Create an API key at: https://featherless.ai/account/api-keys",
        ].join("\n"),
      },
    ],
    catalog: {
      buildProvider: buildFeatherlessProvider,
      buildStaticProvider: buildFeatherlessProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: {
        endpointPath: "models?capabilities=chat",
        buildRequestHeaders: ({ apiKey }) => ({
          Accept: "application/json",
          "User-Agent": "openclaw",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        }),
      },
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    normalizeResolvedModel: ({ model }) => normalizeFeatherlessResolvedModel(model),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
    resolveDynamicModel: (ctx) => resolveFeatherlessDynamicModel(ctx),
    isModernModelRef: () => true,
  },
});
