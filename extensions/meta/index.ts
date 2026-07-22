/**
 * Meta provider plugin entrypoint.
 */
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyMetaConfig, META_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMetaProvider } from "./provider-catalog.js";
import { wrapMetaProviderStream } from "./stream.js";
import { resolveMetaThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "meta";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Meta Provider",
  description: "Bundled Meta provider plugin",
  provider: {
    label: "Meta",
    docsPath: "/providers/meta",
    auth: [
      {
        methodId: "api-key",
        label: "Meta API key",
        hint: "Meta (Responses API)",
        optionKey: "metaApiKey",
        flagName: "--meta-api-key",
        envVar: "MODEL_API_KEY",
        promptMessage: "Enter Meta API key",
        defaultModel: META_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMetaConfig(cfg),
        noteMessage: ["Meta provides Responses API inference."].join("\n"),
        noteTitle: "Meta",
        wizard: {
          groupLabel: "Meta",
          groupHint: "Meta (Responses API)",
        },
      },
    ],
    catalog: {
      buildProvider: buildMetaProvider,
      buildStaticProvider: buildMetaProvider,
      liveModelDiscovery: true,
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    wrapStreamFn: wrapMetaProviderStream,
    resolveThinkingProfile: ({ modelId }) => resolveMetaThinkingProfile(modelId),
  },
});
