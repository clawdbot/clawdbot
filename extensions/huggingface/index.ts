import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyHuggingfaceConfig, HUGGINGFACE_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildHuggingfaceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "huggingface";

type HuggingFacePluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Hugging Face Provider",
  description: "Bundled Hugging Face provider plugin",
  manifest,
  provider: {
    label: "Hugging Face",
    docsPath: "/providers/huggingface",
    envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
    manifestAuth: {
      defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
      applyConfig: applyHuggingfaceConfig,
    },
    catalog: {
      run: async (ctx) => {
        const pluginEntry = ctx.config?.plugins?.entries?.[PROVIDER_ID];
        const pluginConfig =
          pluginEntry && typeof pluginEntry === "object" && pluginEntry.config
            ? (pluginEntry.config as HuggingFacePluginConfig)
            : undefined;
        const discoveryEnabled = pluginConfig?.discovery?.enabled;
        if (discoveryEnabled === false) {
          return null;
        }
        const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...(await buildHuggingfaceProvider(discoveryApiKey)),
            apiKey,
          },
        };
      },
      // Startup and unauthenticated catalog reads must not depend on live discovery.
      staticRun: async () => ({ provider: await buildHuggingfaceProvider() }),
    },
  },
});
