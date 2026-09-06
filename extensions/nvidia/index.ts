// Nvidia plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyNvidiaConfig, NVIDIA_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildLiveNvidiaProvider, buildSelectableNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  manifest,
  provider: {
    label: "NVIDIA",
    docsPath: "/providers/nvidia",
    preserveLiteralProviderPrefix: true,
    manifestAuth: {
      defaultModel: NVIDIA_DEFAULT_MODEL_REF,
      applyConfig: applyNvidiaConfig,
    },
    catalog: {
      discoveryMode: "strict",
      buildProvider: buildLiveNvidiaProvider,
      buildStaticProvider: buildSelectableNvidiaProvider,
    },
    wizard: {
      setup: {
        choiceId: "nvidia-api-key",
        choiceLabel: "NVIDIA API key",
        groupId: "nvidia",
        groupLabel: "NVIDIA",
        groupHint: "Direct API key",
        methodId: "api-key",
        modelSelection: {
          promptWhenAuthChoiceProvided: true,
          allowKeepCurrent: false,
        },
      },
      modelPicker: {
        label: "NVIDIA (custom)",
        hint: "Use NVIDIA-hosted open models",
        methodId: "api-key",
      },
    },
  },
});
