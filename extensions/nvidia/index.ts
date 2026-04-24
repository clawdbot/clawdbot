import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  provider: {
    label: "NVIDIA",
    docsPath: "/providers/nvidia",
    envVars: ["NVIDIA_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "NVIDIA API key",
        hint: "API key",
        optionKey: "nvidiaApiKey",
        flagName: "--nvidia-api-key",
        envVar: "NVIDIA_API_KEY",
        promptMessage: "Enter NVIDIA API key",
        wizard: {
          choiceId: "nvidia-api-key",
          choiceLabel: "NVIDIA API key",
          groupId: "nvidia",
          groupLabel: "NVIDIA",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildNvidiaProvider,
    },
  },
});
