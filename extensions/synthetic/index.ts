import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applySyntheticConfig, SYNTHETIC_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildSyntheticProvider } from "./provider-catalog.js";

const PROVIDER_ID = "synthetic";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Synthetic Provider",
  description: "Bundled Synthetic provider plugin",
  provider: {
    label: "Synthetic",
    docsPath: "/providers/synthetic",
    auth: [
      {
        methodId: "api-key",
        label: "Synthetic API key",
        hint: "Anthropic-compatible (multi-model)",
        optionKey: "syntheticApiKey",
        flagName: "--synthetic-api-key",
        envVar: "SYNTHETIC_API_KEY",
        promptMessage: "Enter Synthetic API key",
        defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applySyntheticConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildSyntheticProvider,
    },
  },
});
