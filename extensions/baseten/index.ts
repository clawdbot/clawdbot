/** Baseten provider plugin entrypoint. */
import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  BASETEN_DEFAULT_MODEL_REF,
  projectBasetenLiveModels,
  resolveBasetenDynamicModel,
} from "./models.js";
import { applyBasetenConfig } from "./onboard.js";
import { buildStaticBasetenProvider } from "./provider-catalog.js";
import { createBasetenThinkingWrapper } from "./stream.js";
import { resolveBasetenThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "baseten";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Baseten Provider",
  description: "Official Baseten Model APIs provider plugin",
  provider: {
    label: "Baseten",
    docsPath: "/providers/baseten",
    auth: [
      {
        methodId: "api-key",
        label: "Baseten API key",
        hint: "Hosted Model APIs, including Inkling",
        optionKey: "basetenApiKey",
        flagName: "--baseten-api-key",
        envVar: "BASETEN_API_KEY",
        promptMessage: "Enter Baseten API key",
        defaultModel: BASETEN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyBasetenConfig(cfg),
        noteTitle: "Baseten",
        noteMessage: [
          "Baseten hosts Thinking Machines Lab's Inkling and other frontier models behind one OpenAI-compatible API.",
          "Get your API key at: https://app.baseten.co/settings/api_keys",
        ].join("\n"),
        wizard: {
          groupLabel: "Baseten",
          groupHint: "Hosted Model APIs, including Inkling",
        },
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx: ProviderCatalogContext) => {
        const { apiKey, discoveryApiKey } = ctx.resolveProviderAuth(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        if (!discoveryApiKey) {
          return { provider: { ...buildStaticBasetenProvider(), apiKey } };
        }
        return {
          provider: await buildOpenAICompatibleLiveModelProviderConfig({
            providerId: PROVIDER_ID,
            providerConfig: buildStaticBasetenProvider(),
            apiKey,
            discoveryApiKey,
            modelDiscovery: {
              timeoutMs: 10_000,
              ttlMs: 5 * 60 * 1000,
              projectRows: projectBasetenLiveModels,
            },
          }),
        };
      },
      staticRun: async () => ({ provider: buildStaticBasetenProvider() }),
    },
    resolveDynamicModel: ({ modelId }) => resolveBasetenDynamicModel(modelId),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    wrapStreamFn: (ctx) => createBasetenThinkingWrapper(ctx),
    resolveThinkingProfile: ({ modelId }) => resolveBasetenThinkingProfile(modelId),
    isModernModelRef: () => true,
  },
});
