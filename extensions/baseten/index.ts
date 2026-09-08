/** Baseten provider plugin entrypoint. */
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { projectBasetenLiveModels, resolveBasetenDynamicModel } from "./models.js";
import { applyBasetenSetupConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildStaticBasetenProvider } from "./provider-catalog.js";
import { createBasetenThinkingWrapper } from "./stream.js";
import { resolveBasetenThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "baseten";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Baseten Provider",
  description: "Official Baseten Model APIs provider plugin",
  manifest,
  provider: {
    label: "Baseten",
    docsPath: "/providers/baseten",
    manifestAuth: {
      applyConfig: applyBasetenSetupConfig,
      noteTitle: "Baseten",
      noteMessage: [
        "Baseten hosts Thinking Machines Lab's Inkling and other frontier models behind one OpenAI-compatible API.",
        "Get your API key at: https://app.baseten.co/settings/api_keys",
      ].join("\n"),
    },
    catalog: {
      order: "simple",
      run: async (ctx: ProviderCatalogContext) => {
        const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderAuth(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        if (!discoveryApiKey) {
          return { provider: { ...buildStaticBasetenProvider(), apiKey } };
        }
        return await buildOpenAICompatibleLiveProviderCatalog({
          discoveryMode: "strict",
          providerId: PROVIDER_ID,
          providerConfig: buildStaticBasetenProvider(),
          apiKey,
          discoveryApiKey,
          profileId,
          modelDiscovery: {
            timeoutMs: 10_000,
            ttlMs: 5 * 60 * 1000,
            projectRows: projectBasetenLiveModels,
          },
        });
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
