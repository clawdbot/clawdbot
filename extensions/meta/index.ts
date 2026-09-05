/**
 * Meta provider plugin entrypoint.
 *
 * Registers the Meta text model provider (Muse Spark, Responses API) and the
 * Meta image-generation provider (muse-image) on a single plugin entry, mirroring
 * the multi-capability shape used by the bundled OpenAI provider plugin.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildOpenAICompatibleProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildMetaImageGenerationProvider } from "./image-generation-provider.js";
import { applyMetaConfig, META_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMetaProvider } from "./provider-catalog.js";
import { wrapMetaProviderStream } from "./stream.js";
import { resolveMetaThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "meta";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Meta Provider",
  description: "Meta provider plugin (Muse Spark text + muse-image generation)",
  register(api: OpenClawPluginApi) {
    const replayFamilyHooks = buildProviderReplayFamilyHooks({ family: "openai-compatible" });

    // Manifest-derived API-key auth (MODEL_API_KEY), matching the values in
    // openclaw.plugin.json providerAuthChoices/setup.
    const apiKeyAuth = createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "api-key",
      label: "Meta API key",
      hint: "Meta (Responses API)",
      optionKey: "metaApiKey",
      flagName: "--meta-api-key",
      envVar: "MODEL_API_KEY",
      promptMessage: "Enter Meta API key",
      defaultModel: META_DEFAULT_MODEL_REF,
      expectedProviders: [PROVIDER_ID],
      applyConfig: (cfg: OpenClawConfig) => applyMetaConfig(cfg),
      noteTitle: "Meta",
      noteMessage: "Meta provides Responses API inference.",
      wizard: {
        choiceId: "meta-api-key",
        choiceLabel: "Meta API key",
        groupId: "meta",
        groupLabel: "Meta",
        groupHint: "Meta (Responses API)",
        onboardingFeatured: true,
        methodId: "api-key",
      },
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Meta",
      docsPath: "/providers/meta",
      envVars: ["MODEL_API_KEY"],
      auth: [apiKeyAuth],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildOpenAICompatibleProviderCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildMetaProvider,
          }),
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({ provider: buildMetaProvider() }),
      },
      // Provider-owned behavior preserved from the previous single-provider entry.
      ...replayFamilyHooks,
      wrapSimpleCompletionStreamFn: wrapMetaProviderStream,
      wrapStreamFn: wrapMetaProviderStream,
      resolveThinkingProfile: resolveMetaThinkingProfile,
    });

    api.registerImageGenerationProvider(buildMetaImageGenerationProvider());
  },
});
